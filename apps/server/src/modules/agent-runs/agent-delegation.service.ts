import { createHash } from 'node:crypto';

import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AgentRunConfig,
  AgentRunFailure,
  AgentRunStatus,
  type ModelChoice,
  ReportAgentRunDto,
  RoleEnum,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { convertTiptapJsonToMarkdown } from 'common/utils/tiptap.utils';

import IssueCommentsService from 'modules/issue-comments/issue-comments.service';
import LinkedIssueService from 'modules/linked-issue/linked-issue.service';
import { LoggerService } from 'modules/logger/logger.service';

import {
  agentBoundExecutor,
  workspaceAgentDefaults,
} from './agent-run-settings';
import { AGENT_RUN_WORKSPACE_CONCURRENCY } from './agent-runs.interface';
import { AgentRunsService } from './agent-runs.service';
import { ContextPackService } from './context-pack.service';
import { ExecutorRegistry } from './executors/executor.registry';

/** States in which a run still counts against the concurrency cap. */
const LIVE_STATUSES: AgentRunStatus[] = ['QUEUED', 'CLAIMED', 'RUNNING'];

/**
 * Below this a description is not a problem statement, and an agent handed it
 * will invent the requirements it was not given. Matches the threshold the MCP
 * create_task tool already holds callers to.
 */
const MIN_DESCRIPTION_LENGTH = 40;

export interface DelegateInput {
  issueId: string;
  workspaceId: string;
  agentUserId: string;
  /** The member delegating. Never derived from issue content. */
  createdById: string | null;
  /** What the delegating member knows that the issue does not say. */
  guidance?: string;
  executor?: string | null;
  config?: AgentRunConfig;
  force?: boolean;
}

/**
 * Deciding when a run is created, what the agent is told, and which backend
 * takes it.
 *
 * This is the layer that makes "assign it to the agent" a real gesture rather
 * than a convention.
 */
@Injectable()
export class AgentDelegationService {
  private readonly logger = new LoggerService('AgentDelegationService');

  constructor(
    private prisma: PrismaService,
    private agentRuns: AgentRunsService,
    private contextPacks: ContextPackService,
    private registry: ExecutorRegistry,
    private linkedIssues: LinkedIssueService,
    private comments: IssueCommentsService,
  ) {}

  // ------------------------------------------------------------- delegating

  async delegate(input: DelegateInput) {
    const issue = await this.prisma.issue.findFirst({
      where: { id: input.issueId, deleted: null },
      include: { team: true },
    });

    if (!issue || issue.team.workspaceId !== input.workspaceId) {
      throw new BadRequestException({
        message: `Issue ${input.issueId} not found in this workspace.`,
      });
    }

    await this.assertWorthDelegating(issue.description, issue.id);
    await this.assertNoLiveRun(input.issueId, input.force ?? false);
    await this.assertBelowConcurrencyCap(input.workspaceId);

    const executor = await this.resolveExecutor(input);

    const availability = await executor.availability(input.workspaceId);
    if (availability.available === false) {
      throw new BadRequestException({ message: availability.reason });
    }

    const contextPack = await this.contextPacks.build(
      input.issueId,
      input.workspaceId,
      input.config,
      input.guidance,
    );

    // What to run on, layered the same way everything else is: the workspace's
    // default underneath, this request's choice on top. Stored on the run
    // rather than resolved again at dispatch, so a later change to the
    // workspace default cannot rewrite what a finished run was asked to do.
    const config = {
      ...contextPack.repo,
      ...(await this.resolveModel(input)),
    };

    const run = await this.agentRuns.createRun({
      workspaceId: input.workspaceId,
      issueId: input.issueId,
      agentUserId: input.agentUserId,
      createdById: input.createdById,
      executor: executor.key,
      config,
      contextPack,
      configHash: hashConfig(config, executor.key),
    });

    // A dispatch that fails has to land as a visible state on the run. The
    // existing tasks.trigger call sites in issues.service are fire-and-forget
    // with no catch, so with no worker reachable they become unhandled
    // rejections rather than logged failures. Not a pattern to copy.
    try {
      await executor.dispatch(run);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error({
        message: `Dispatching agent run ${run.id} to ${executor.key} failed: ${message}`,
        where: 'AgentDelegationService.delegate',
        error: error instanceof Error ? error : undefined,
      });

      return this.agentRuns.transition(run.id, 'FAILED', {
        failure: 'ENVIRONMENT_SETUP_FAILED' as AgentRunFailure,
        error: `Could not hand the run to the ${executor.key} executor: ${message}`,
      });
    }

    return run;
  }

  /**
   * The assignment trigger.
   *
   * Assigning an issue to an AGENT user is the natural gesture for "you do
   * this", so it enqueues a run. Moving it back to a human cancels one that
   * has not started — but deliberately not one already RUNNING, because
   * killing work in flight is a decision someone should make explicitly
   * rather than a side effect of tidying the board.
   *
   * Never throws into the caller. This runs off the back of a normal issue
   * update, and a delegation that cannot start must not fail the assignment
   * the user actually asked for.
   */
  async onAssigneeChanged(
    issueId: string,
    workspaceId: string,
    previousAssigneeId: string | null,
    nextAssigneeId: string | null,
    actorId: string,
  ): Promise<void> {
    if (previousAssigneeId === nextAssigneeId) {
      return;
    }

    try {
      if (nextAssigneeId && (await this.isAgent(nextAssigneeId, workspaceId))) {
        await this.delegate({
          issueId,
          workspaceId,
          agentUserId: nextAssigneeId,
          createdById: actorId,
        });
        return;
      }

      // Moved off an agent: withdraw work that has not begun.
      if (
        previousAssigneeId &&
        (await this.isAgent(previousAssigneeId, workspaceId))
      ) {
        await this.cancelUnstarted(issueId, previousAssigneeId);
      }
    } catch (error) {
      this.logger.info({
        message: `Assignment on issue ${issueId} did not change agent work: ${
          error instanceof Error ? error.message : String(error)
        }`,
        where: 'AgentDelegationService.onAssigneeChanged',
      });
    }
  }

  private async cancelUnstarted(issueId: string, agentUserId: string) {
    const queued = await this.prisma.agentRun.findMany({
      where: {
        issueId,
        agentUserId,
        status: 'QUEUED',
        deleted: null,
      },
      select: { id: true, workspaceId: true },
    });

    for (const run of queued) {
      await this.agentRuns
        .cancelRun(
          run.id,
          { workspaceId: run.workspaceId },
          'The issue was reassigned away from the agent.',
        )
        .catch((): undefined => undefined);
    }
  }

  // ---------------------------------------------------------------- handback

  /**
   * What happens when an executor reports a result.
   *
   * The server does the linking and the commenting; the executor reports facts
   * and never writes to the issue itself. That is the whole handback contract,
   * and keeping it here means every backend produces an identical-looking
   * result — a reader cannot tell whether a run happened on someone's laptop
   * or in a hosted sandbox, which is exactly right.
   */
  async report(runId: string, report: ReportAgentRunDto, workspaceId: string) {
    const run = await this.agentRuns.getRun(runId, { workspaceId });

    const status: AgentRunStatus = report.failure
      ? 'FAILED'
      : report.needsReview
        ? 'NEEDS_REVIEW'
        : 'SUCCEEDED';

    const delivery =
      report.delivery ??
      (report.prUrl
        ? 'pull_request'
        : report.worktreePath
          ? 'worktree'
          : undefined);

    // Linking before the transition, so a finished run never renders without
    // the artifact it is pointing at.
    let linkedIssueId: string | undefined;
    if (report.prUrl) {
      linkedIssueId = await this.linkPullRequest(
        run.issueId,
        report.prUrl,
        run.agentUserId,
      );
    }

    const updated = await this.agentRuns.transition(runId, status, {
      summary: report.summary,
      error: report.error,
      failure: report.failure ?? null,
      harnessVersion: report.harnessVersion,
      modelId: report.modelId,
      baseCommit: report.baseCommit,
      iterationCount: report.iterationCount,
      phaseTimings: report.phaseTimings,
      result: {
        ...(delivery ? { delivery } : {}),
        ...(report.branch ? { branch: report.branch } : {}),
        ...(report.prUrl ? { prUrl: report.prUrl } : {}),
        ...(report.worktreePath ? { worktreePath: report.worktreePath } : {}),
        ...(linkedIssueId ? { linkedIssueId } : {}),
        ...(report.headCommit ? { headCommit: report.headCommit } : {}),
        ...(report.counters ?? {}),
      },
    });

    await this.postSummary(run.issueId, run.agentUserId, runId, {
      status,
      summary: report.summary,
      error: report.error,
      failure: report.failure,
      branch: report.branch,
      prUrl: report.prUrl,
      worktreePath: report.worktreePath,
      attempt: run.attempt,
    });

    return updated;
  }

  private async linkPullRequest(
    issueId: string,
    url: string,
    agentUserId: string,
  ): Promise<string | undefined> {
    // Idempotent: a runner that reports twice — a retried HTTP call, say —
    // must not leave the issue carrying the same pull request twice.
    const existing = await this.linkedIssues.getLinkedIssueByUrl(url);
    const here = existing.find((linked) => linked.issueId === issueId);

    if (here) {
      return here.id;
    }

    try {
      const created = await this.linkedIssues.createLinkIssue(
        { url, sourceData: { source: 'agent-run' } },
        { issueId },
        agentUserId,
      );
      return 'id' in created ? created.id : undefined;
    } catch (error) {
      // A failed link must not lose the run's result. The PR url is on the
      // run record either way, so the work is still reachable.
      this.logger.error({
        message: `Could not link ${url} to issue ${issueId}: ${error}`,
        where: 'AgentDelegationService.linkPullRequest',
        error: error instanceof Error ? error : undefined,
      });
      return undefined;
    }
  }

  /**
   * The agent-authored summary comment.
   *
   * Rendered here rather than accepted from the executor, so an executor
   * cannot post arbitrary markdown to an issue as the agent identity — and so
   * a failed run reads as usefully as a successful one, which is the half
   * everybody skips.
   */
  private async postSummary(
    issueId: string,
    agentUserId: string,
    runId: string,
    outcome: {
      status: AgentRunStatus;
      summary?: string;
      error?: string;
      failure?: AgentRunFailure;
      branch?: string;
      prUrl?: string;
      worktreePath?: string;
      attempt: number;
    },
  ) {
    const lines: string[] = [];

    if (outcome.status === 'SUCCEEDED') {
      lines.push(outcome.summary ?? 'Finished the work.');
    } else if (outcome.status === 'NEEDS_REVIEW') {
      lines.push(
        `**Needs a human.** ${outcome.summary ?? 'The run finished but could not confirm it met the Definition of Done.'}`,
      );
    } else {
      lines.push(
        `**Could not finish** (attempt ${outcome.attempt})${
          outcome.failure ? ` — ${describeFailure(outcome.failure)}` : ''
        }.`,
      );
      if (outcome.error) {
        lines.push('', '```', outcome.error.slice(0, 1500), '```');
      }
    }

    if (outcome.prUrl) {
      lines.push('', `Pull request: ${outcome.prUrl}`);
    } else if (outcome.worktreePath) {
      // No remote to push to, so the work is a branch in a worktree on the
      // machine that ran it. Give the reader the command, not just the path.
      lines.push(
        '',
        `Ready for review in a worktree${outcome.branch ? ` on \`${outcome.branch}\`` : ''}:`,
        '',
        '```bash',
        `cd ${outcome.worktreePath}`,
        '```',
      );
    } else if (outcome.branch) {
      lines.push('', `Branch: \`${outcome.branch}\``);
    }

    try {
      await this.comments.createIssueComment({ issueId }, agentUserId, {
        bodyMarkdown: lines.join('\n'),
        // Names the run this comment reports on. The issue view renders it as
        // the run's card rather than as prose, so the handback is one object in
        // the feed instead of a card and a paraphrase of it side by side. Every
        // other reader — the API, MCP, mail — still gets the markdown, which is
        // why this stays a comment rather than becoming a client-only card.
        sourceMetadata: { source: 'agent-run', agentRunId: runId },
      });
    } catch (error) {
      this.logger.error({
        message: `Could not post the agent summary on issue ${issueId}: ${error}`,
        where: 'AgentDelegationService.postSummary',
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  // ----------------------------------------------------------------- guards

  /**
   * Refuses an issue too thin to act on.
   *
   * An agent handed a one-line issue does not stop; it invents the
   * requirements it was not given and produces a confident diff against them.
   * Cheaper to refuse here than to review that.
   */
  private async assertWorthDelegating(description: string | null, id: string) {
    const text = plainText(description);

    if (text.length < MIN_DESCRIPTION_LENGTH) {
      throw new BadRequestException({
        message:
          `Issue ${id} has too little description to delegate. An agent ` +
          'given a one-line issue will invent the requirements it was not ' +
          'given. Say what the problem is and what done looks like first.',
      });
    }
  }

  private async assertNoLiveRun(issueId: string, force: boolean) {
    if (force) {
      return;
    }

    const live = await this.prisma.agentRun.findFirst({
      where: { issueId, status: { in: LIVE_STATUSES }, deleted: null },
      select: { id: true, status: true },
    });

    if (live) {
      throw new BadRequestException({
        message:
          `This issue already has a run in progress (${live.id}, ` +
          `${live.status}). Two agents on one issue produce two branches ` +
          'nobody asked for. Cancel it first, or pass force to run anyway.',
      });
    }
  }

  private async assertBelowConcurrencyCap(workspaceId: string) {
    const live = await this.prisma.agentRun.count({
      where: {
        workspaceId,
        status: { in: LIVE_STATUSES },
        deleted: null,
      },
    });

    if (live >= AGENT_RUN_WORKSPACE_CONCURRENCY) {
      throw new BadRequestException({
        message:
          `This workspace already has ${live} agent runs in flight, which is ` +
          `the cap. A script that delegates a whole backlog is a plausible ` +
          `accident and its cost lands on whoever holds the model key. Wait ` +
          `for one to finish, or raise AGENT_RUN_WORKSPACE_CONCURRENCY.`,
      });
    }
  }

  // --------------------------------------------------------------- resolving

  private async resolveExecutor(input: DelegateInput) {
    const [membership, workspace] = await Promise.all([
      this.prisma.usersOnWorkspaces.findFirst({
        where: { userId: input.agentUserId, workspaceId: input.workspaceId },
        select: { settings: true },
      }),
      this.prisma.workspace.findUnique({
        where: { id: input.workspaceId },
        select: { preferences: true },
      }),
    ]);

    return this.registry.resolve({
      requested: input.executor,
      agentBound: agentBoundExecutor(membership?.settings),
      workspaceDefault: workspaceAgentDefaults(workspace?.preferences)
        .defaultExecutor,
    });
  }

  /**
   * The provider, model and thinking level this run should use.
   *
   * The workspace default, with anything the request named over it — field by
   * field, so a run that overrides only the thinking level keeps the
   * workspace's provider and model rather than losing them.
   */
  private async resolveModel(input: DelegateInput): Promise<ModelChoice> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: input.workspaceId },
      select: { preferences: true },
    });

    const fallback = workspaceAgentDefaults(workspace?.preferences).model;

    return {
      ...fallback,
      ...stripUndefined({
        provider: input.config?.provider,
        model: input.config?.model,
        thinking: input.config?.thinking,
      }),
    };
  }

  private async isAgent(userId: string, workspaceId: string) {
    const membership = await this.prisma.usersOnWorkspaces.findFirst({
      where: { userId, workspaceId, status: 'ACTIVE' },
      select: { role: true },
    });

    return membership?.role === RoleEnum.AGENT;
  }
}

/**
 * A config hash, so two runs asked the same question are recognisable as such.
 *
 * Keys are sorted before hashing: JSON.stringify preserves insertion order, so
 * without this the same configuration reached by two code paths hashes
 * differently and the comparison the field exists for silently stops working.
 */
function hashConfig(config: object, executorKey: string): string {
  const sorted = Object.fromEntries(
    Object.entries(config).sort(([a], [b]) => a.localeCompare(b)),
  );

  return createHash('sha256')
    .update(JSON.stringify({ executor: executorKey, ...sorted }))
    .digest('hex')
    .slice(0, 16);
}

/**
 * The prose in a description, with the markup taken off.
 *
 * Descriptions are stored as tiptap JSON, where the structural keys — `type`,
 * `content`, `paragraph`, `doc` — are themselves words. Stripping punctuation
 * and measuring what is left counts those, so `{"type":"doc",…,"text":"fix
 * it"}` reads as a long description while saying nothing. Converting to
 * markdown first measures what a person would actually read.
 */
function plainText(description: string | null): string {
  const body = (description ?? '').trim();

  if (!body) {
    return '';
  }

  if (body.startsWith('{')) {
    try {
      return convertTiptapJsonToMarkdown(body).trim();
    } catch {
      // Malformed JSON in the column. Treat it as having no description
      // rather than letting the raw blob through on length.
      return '';
    }
  }

  return body
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const FAILURE_PROSE: Record<AgentRunFailure, string> = {
  ENVIRONMENT_SETUP_FAILED: 'the environment would not build',
  HARNESS_CRASHED: 'the harness crashed',
  BUDGET_EXHAUSTED: 'it ran out of budget',
  NO_DIFF_PRODUCED: 'it finished without changing anything',
  VERIFICATION_FAILED: 'the checks did not pass',
  PUSH_REJECTED: 'the push was rejected',
  PR_CREATION_FAILED: 'the branch went up but the pull request did not',
  EGRESS_DENIED: 'the sandbox blocked a network call it needed',
  LEASE_LOST: 'the runner stopped responding',
  NOT_TEST_SPECIFIABLE: 'this issue cannot be pinned down with tests',
  REWARD_HACK_SUSPECTED: 'it was optimising the tests rather than the problem',
};

function describeFailure(failure: AgentRunFailure): string {
  return FAILURE_PROSE[failure] ?? failure.toLowerCase().replace(/_/g, ' ');
}

/**
 * An override that was not supplied must not blank out the default under it.
 *
 * `{...defaults, ...{model: undefined}}` sets model to undefined, which is how
 * a run that overrode only the thinking level would lose the workspace's model.
 */
function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

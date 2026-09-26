import { Injectable } from '@nestjs/common';
import { AgentRunFailure, AgentRunStatus } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import IssueCommentsService from 'modules/issue-comments/issue-comments.service';
import LinkedIssueService from 'modules/linked-issue/linked-issue.service';
import { LoggerService } from 'modules/logger/logger.service';

export interface HandbackOutcome {
  status: AgentRunStatus;
  /** The agent's own closing report. Rendered as the body of the comment. */
  summary?: string | null;
  error?: string | null;
  failure?: AgentRunFailure | null;
  branch?: string | null;
  prUrl?: string | null;
  worktreePath?: string | null;
  attempt: number;
  /**
   * The attempt already running in this one's place, when the server opened
   * one by itself.
   *
   * Only the sweep sets it. A person who retries a run is looking at the
   * screen when they do it and does not need to be told; a run the server gave
   * up on and replaced produces a second run out of nowhere, and an issue that
   * does not say so reads as an agent that ran twice for no reason.
   */
  nextAttempt?: number | null;
}

/**
 * Everything a run writes back to the issue: the link to what it produced, and
 * the comment describing it.
 *
 * Its own service rather than a private method on an executor, because a
 * reader of an issue must not be able to tell which backend did the work. Both
 * halves have been learned the hard way. The comment lived on the reporting
 * path and the sandbox never reached it, so a hosted run — success or failure
 * — left no trace on the issue at all. The link had the same shape one layer
 * up: it lived on the same reporting path, so a hosted run opened a pull
 * request that appeared nowhere in the issue's links.
 *
 * Rendered here rather than accepted from an executor, so an executor cannot
 * post arbitrary markdown to an issue as the agent identity — and so a failed
 * run reads as usefully as a successful one, which is the half everybody skips.
 */
@Injectable()
export class RunHandbackService {
  private readonly logger = new LoggerService('RunHandbackService');

  constructor(
    private prisma: PrismaService,
    private comments: IssueCommentsService,
    private linkedIssues: LinkedIssueService,
  ) {}

  async post(
    issueId: string,
    agentUserId: string,
    runId: string,
    outcome: HandbackOutcome,
  ): Promise<void> {
    // Linked before the comment is written, so a reader who follows the
    // handback finds the pull request already on the issue rather than
    // arriving a moment before it does.
    if (outcome.prUrl) {
      await this.linkPullRequest(issueId, outcome.prUrl, agentUserId);
    }

    const lines: string[] = [];

    if (outcome.status === 'SUCCEEDED') {
      lines.push(outcome.summary ?? 'Finished the work.');
    } else if (outcome.status === 'NEEDS_REVIEW') {
      lines.push(
        `**Needs a human.** ${
          outcome.summary ??
          'The run finished but could not confirm it met the Definition of Done.'
        }`,
      );
    } else {
      lines.push(
        `**Could not finish** (attempt ${outcome.attempt})${
          outcome.failure ? ` — ${describeFailure(outcome.failure)}` : ''
        }.`,
      );

      // What it managed before it broke. A failed run that says only how it
      // died sends the reader to a log; one that says what it had done by then
      // is often enough to fix the issue without opening anything.
      if (outcome.summary) {
        lines.push('', outcome.summary);
      }

      if (outcome.error) {
        lines.push('', '```', outcome.error.slice(0, 1500), '```');
      }
    }

    if (outcome.nextAttempt) {
      lines.push('', `Attempt ${outcome.nextAttempt} has already started.`);
    }

    const standing = await this.definitionOfDone(issueId);

    if (standing) {
      lines.push('', standing);
    }

    if (outcome.prUrl) {
      lines.push('', `Pull request: ${outcome.prUrl}`);
    } else if (outcome.worktreePath) {
      // No remote to push to, so the work is a branch in a worktree on the
      // machine that ran it. Give the reader the command, not just the path.
      lines.push(
        '',
        `Ready for review in a worktree${
          outcome.branch ? ` on \`${outcome.branch}\`` : ''
        }:`,
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
        where: 'RunHandbackService.post',
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Puts the pull request on the issue.
   *
   * Idempotent: a run reported twice — a retried call, an executor that both
   * transitions and reports — must not leave the issue carrying the same pull
   * request twice.
   *
   * A failed link must not cost the run its handback. The url is on the run
   * record and in the comment either way, so the work stays reachable; a
   * missing link row is a smaller loss than a silent run.
   */
  private async linkPullRequest(
    issueId: string,
    url: string,
    agentUserId: string,
  ): Promise<void> {
    try {
      const existing = await this.linkedIssues.getLinkedIssueByUrl(url);

      if (existing.some((linked) => linked.issueId === issueId)) {
        return;
      }

      await this.linkedIssues.createLinkIssue(
        { url, sourceData: { source: 'agent-run' } },
        { issueId },
        agentUserId,
      );
    } catch (error) {
      this.logger.error({
        message: `Could not link ${url} to issue ${issueId}: ${error}`,
        where: 'RunHandbackService.linkPullRequest',
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Where the Definition of Done stands, stated in the handback.
   *
   * The agent's own report says which criteria it believes it met. This says
   * which are still open on the issue, which is a different fact and the one a
   * reviewer is about to check. Nothing here ticks anything: a run does not get
   * to grade itself, and a criterion is ticked by whoever accepts the work.
   *
   * Absent when the issue has no criteria — a line saying "0 of 0" is noise on
   * an issue that never set a bar.
   */
  private async definitionOfDone(issueId: string): Promise<string | null> {
    // Wrapped whole. This is a decoration on a comment that has to be posted
    // either way, so nothing here — a missing table on an older schema, a
    // read that times out — may cost the run its only word to the issue.
    let criteria: Array<{ body: string; completed: boolean }> = [];

    try {
      criteria = await this.prisma.checklistItem.findMany({
        where: { issueId, deleted: null },
        select: { body: true, completed: true },
        orderBy: { sortOrder: 'asc' },
      });
    } catch {
      return null;
    }

    if (criteria.length === 0) {
      return null;
    }

    const open = criteria.filter((criterion) => !criterion.completed);

    if (open.length === 0) {
      return `Definition of Done: all ${criteria.length} criteria are ticked.`;
    }

    return [
      `Definition of Done: ${criteria.length - open.length} of ${
        criteria.length
      } ticked. Still open:`,
      '',
      ...open.map((criterion) => `- [ ] ${criterion.body}`),
    ].join('\n');
  }
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
  LEASE_LOST: 'it stopped responding',
  NOT_TEST_SPECIFIABLE: 'this issue cannot be pinned down with tests',
  REWARD_HACK_SUSPECTED: 'it was optimising the tests rather than the problem',
};

export function describeFailure(failure: AgentRunFailure): string {
  return FAILURE_PROSE[failure] ?? failure.toLowerCase().replace(/_/g, ' ');
}

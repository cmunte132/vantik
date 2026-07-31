import { Injectable } from '@nestjs/common';
import { AgentRunFailure, AgentRunStatus } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import IssueCommentsService from 'modules/issue-comments/issue-comments.service';
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
}

/**
 * The one thing a run writes back to the issue.
 *
 * Its own service rather than a private method on the delegation service,
 * because both delivery paths have to reach it and only one of them did. The
 * BYO runner reports over HTTP and got a comment; the hosted sandbox
 * transitions the run in-process and got nothing, so a sandbox run — success
 * or failure — left no trace on the issue at all. A reader of the issue could
 * not tell an agent had ever touched it.
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
  ) {}

  async post(
    issueId: string,
    agentUserId: string,
    runId: string,
    outcome: HandbackOutcome,
  ): Promise<void> {
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
  LEASE_LOST: 'the runner stopped responding',
  NOT_TEST_SPECIFIABLE: 'this issue cannot be pinned down with tests',
  REWARD_HACK_SUSPECTED: 'it was optimising the tests rather than the problem',
};

export function describeFailure(failure: AgentRunFailure): string {
  return FAILURE_PROSE[failure] ?? failure.toLowerCase().replace(/_/g, ' ');
}

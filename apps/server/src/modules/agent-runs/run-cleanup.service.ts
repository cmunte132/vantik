import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import {
  type AgentRunCleanup,
  type AgentRunRepoSource,
  type AgentRunResult,
  type AgentRunStatus,
  CLEANABLE_AGENT_RUN_STATUSES,
  needsAgentRunCleanup,
} from '@vantikhq/types';

import { AgentRunsService, type AgentRunScope } from './agent-runs.service';
import { GitProxyService } from './sandbox/git-proxy.service';

/**
 * Removes what a finished run left on the git host, at a person's request.
 *
 * A run awaiting review leaves an open pull request and its branch; a run
 * that failed after pushing leaves the branch. A retry never needs them gone
 * (it pushes to a fresh branch name), but a person who has decided against
 * the work should not have to go to the host to tidy up after it.
 */
@Injectable()
export class RunCleanupService {
  constructor(
    private agentRuns: AgentRunsService,
    private gitProxy: GitProxyService,
  ) {}

  /**
   * Closes the run's pull request and deletes its branch, and records what
   * was done on the run. Asking again after a full cleanup answers with the
   * cleanup already recorded; asking after a partial one tries what failed.
   */
  async cleanUp(
    runId: string,
    scope: AgentRunScope,
    userId: string,
  ): Promise<AgentRunCleanup> {
    const run = await this.agentRuns.getRun(runId, scope);
    const status = run.status as AgentRunStatus;
    const result = (run.result ?? {}) as AgentRunResult;

    if (!CLEANABLE_AGENT_RUN_STATUSES.includes(status)) {
      throw new ConflictException({
        message:
          status === 'SUCCEEDED'
            ? `Agent run ${runId} succeeded, and its pull request is the work. Close it on the host if you do not want it.`
            : `Agent run ${runId} is ${status}. Cancel it before cleaning up after it.`,
      });
    }

    if (!needsAgentRunCleanup(run)) {
      return (
        result.cleanedUp ?? {
          at: new Date().toISOString(),
          byUserId: userId,
          pullRequest: 'none',
          branch: 'none',
        }
      );
    }

    const source = (run.config as { source?: AgentRunRepoSource } | null)
      ?.source;

    if (!source?.integrationAccountId || !source.externalRepoId) {
      throw new BadRequestException({
        message: `Agent run ${runId} records no connected repository, so there is nothing the server can reach to clean up.`,
      });
    }

    const previous = result.cleanedUp;
    const outcome = await this.gitProxy.cleanUp({
      workspaceId: run.workspaceId,
      source,
      // Only the halves not already done: a pull request closed by an
      // earlier, partial cleanup is not closed again.
      ...(result.branch && !done(previous?.branch)
        ? { branch: result.branch, headCommit: result.headCommit }
        : {}),
      ...(result.prUrl && !done(previous?.pullRequest)
        ? { prUrl: result.prUrl }
        : {}),
      comment:
        `Closed from Vantik: the agent run that opened this (${runId}) was ` +
        `cleaned up without merging. Its branch is deleted unless commits ` +
        `were added to it.`,
    });

    const cleanup: AgentRunCleanup = {
      at: new Date().toISOString(),
      byUserId: userId,
      pullRequest:
        outcome.pullRequest === 'none' && previous && done(previous.pullRequest)
          ? previous.pullRequest
          : outcome.pullRequest,
      branch:
        outcome.branch === 'none' && previous && done(previous.branch)
          ? previous.branch
          : outcome.branch,
      ...(outcome.detail ? { detail: outcome.detail } : {}),
    };

    await this.agentRuns.recordCleanup(run.id, cleanup, describe(cleanup));

    return cleanup;
  }
}

function done(part: string | undefined): boolean {
  return part !== undefined && part !== 'failed' && part !== 'none';
}

/** The cleanup in words, for the run's timeline. */
export function describe(cleanup: AgentRunCleanup): string {
  const pullRequest = {
    closed: 'Closed the pull request.',
    already_closed: 'The pull request was already closed.',
    merged: 'The pull request was already merged.',
    none: '',
    failed: 'Could not close the pull request.',
  }[cleanup.pullRequest];
  const branch = {
    deleted: 'Deleted the branch.',
    already_gone: 'The branch was already gone.',
    kept_moved: 'Kept the branch, which has commits added since.',
    kept: 'Kept the branch.',
    none: '',
    failed: 'Could not delete the branch.',
  }[cleanup.branch];

  return [`Cleaned up after the run.`, pullRequest, branch, cleanup.detail]
    .filter(Boolean)
    .join(' ');
}

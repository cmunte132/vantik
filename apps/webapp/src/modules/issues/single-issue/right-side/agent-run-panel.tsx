/* eslint-disable @typescript-eslint/no-explicit-any */
import { Button } from '@vantikhq/ui/components/button';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import React from 'react';

import { useIssueData } from 'hooks/issues';

import { useCancelRunMutation, useRetryRunMutation } from 'services/agent-runs';

import { useContextStore } from 'store/global-context-provider';

import {
  FAILURE_PROSE,
  STATUS_LABEL,
  elapsed,
  isLive,
} from 'modules/agent-runs/run-vocabulary';

/**
 * What an agent is doing, or did, on this issue.
 *
 * Updates over the sync delta rather than polling: `AgentRun` and
 * `AgentRunEvent` ride the existing websocket replication, so a run that
 * changes state in a sandbox somewhere is reflected here without this
 * component asking anything.
 */
export const AgentRunPanel = observer(() => {
  const issue = useIssueData();
  const { agentRunsStore } = useContextStore();
  const [expanded, setExpanded] = React.useState(false);

  const run = agentRunsStore.getCurrentRunForIssue(issue?.id);

  const { mutate: cancelRun } = useCancelRunMutation();
  const { mutate: retryRun } = useRetryRunMutation();

  // Events are loaded per run rather than held for every run at once: a chatty
  // harness writes thousands of lines and only one run is ever on screen.
  React.useEffect(() => {
    if (run?.id) {
      agentRunsStore.loadEvents(run.id);
    }
  }, [run?.id, agentRunsStore]);

  // A live run's elapsed time has to tick on its own — no sync event arrives
  // just because a second passed.
  const [, forceTick] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (!run || !isLive(run.status)) {
      return undefined;
    }
    const timer = setInterval(forceTick, 1000);
    return () => clearInterval(timer);
  }, [run?.status, run]);

  if (!run) {
    return null;
  }

  const live = isLive(run.status);
  const events = agentRunsStore.getEvents(run.id);
  const failure = run.failure ? FAILURE_PROSE[run.failure] : undefined;
  const result = run.result ?? {};

  // Collapsed to the last few lines by default. A run's log is worth having
  // and almost never worth reading in full.
  const shown = expanded ? events.slice(-500) : events.slice(-4);

  return (
    <div className="flex flex-col gap-2 border-t border-border py-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'size-2 rounded-full',
              live && 'animate-pulse bg-primary',
              run.status === 'SUCCEEDED' && 'bg-green-500',
              run.status === 'NEEDS_REVIEW' && 'bg-amber-500',
              ['FAILED', 'EXPIRED'].includes(run.status) && 'bg-destructive',
              run.status === 'CANCELED' && 'bg-muted-foreground',
            )}
          />
          <span className="text-sm">
            {STATUS_LABEL[run.status] ?? run.status}
          </span>
        </div>

        <span className="text-xs text-muted-foreground">
          {live && run.startedAt
            ? elapsed(run.startedAt)
            : elapsed(run.startedAt, run.finishedAt)}
          {run.attempt > 1 ? ` · attempt ${run.attempt}` : ''}
        </span>
      </div>

      {failure && (
        <div className="rounded bg-destructive/10 px-2 py-1.5 text-xs">
          <div>It {failure.what}.</div>
          <div className="text-muted-foreground">{failure.next}</div>
        </div>
      )}

      {run.summary && !failure && (
        <p className="text-xs text-muted-foreground">{run.summary}</p>
      )}

      {/* Where the work ended up: a pull request, or a worktree to cd into. */}
      {result.prUrl && (
        <a
          href={result.prUrl}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-primary hover:underline"
        >
          Review the pull request →
        </a>
      )}

      {/* A branch pushed without a pull request — a local remote, or a host
          we could not open one on. Without this the run says it succeeded and
          then says nothing about where the work went. */}
      {!result.prUrl && !result.worktreePath && result.branch && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            Pushed as a branch:
          </span>
          <code className="select-all rounded bg-muted px-2 py-1 text-xs">
            {result.branch}
          </code>
        </div>
      )}

      {!result.prUrl && result.worktreePath && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            Ready to review locally:
          </span>
          <code className="select-all rounded bg-muted px-2 py-1 text-xs">
            cd {result.worktreePath}
          </code>
        </div>
      )}

      {(result.filesChanged != null || run.modelId) && (
        <div className="flex gap-3 text-xs text-muted-foreground">
          {result.filesChanged != null && (
            <span>
              {result.filesChanged} file{result.filesChanged === 1 ? '' : 's'}
              {result.insertions != null && ` +${result.insertions}`}
              {result.deletions != null && ` −${result.deletions}`}
            </span>
          )}
          {run.modelId && <span>{run.modelId}</span>}
        </div>
      )}

      {events.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {shown.map((event: any) => (
            <div
              key={event.id}
              className={cn(
                'truncate text-xs text-muted-foreground',
                event.level === 'ERROR' && 'text-destructive',
              )}
            >
              {event.message}
            </div>
          ))}

          {events.length > 4 && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              className="self-start text-xs text-muted-foreground hover:underline"
            >
              {expanded ? 'Show less' : `Show all ${events.length}`}
            </button>
          )}
        </div>
      )}

      <div className="flex gap-2">
        {live && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => cancelRun({ runId: run.id })}
          >
            Stop
          </Button>
        )}
        {/* Retryable only from the states where trying again is informative;
            re-running work that succeeded would open a second pull request. */}
        {['FAILED', 'EXPIRED', 'NEEDS_REVIEW'].includes(run.status) && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => retryRun({ runId: run.id })}
          >
            Try again
          </Button>
        )}
      </div>
    </div>
  );
});

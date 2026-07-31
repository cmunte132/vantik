/* eslint-disable @typescript-eslint/no-explicit-any */
import { Button } from '@vantikhq/ui/components/button';
import { observer } from 'mobx-react-lite';
import { useRouter } from 'next/router';
import React from 'react';
import ReactTimeAgo from 'react-time-ago';

import type { User } from 'common/types';
import { getUserIcon } from 'common/user-util';
import { workspaceHref } from 'common/workspace-href';

import { useCancelRunMutation, useRetryRunMutation } from 'services/agent-runs';

import { useContextStore } from 'store/global-context-provider';

import {
  FAILURE_PROSE,
  PHASE_LABEL,
  duration,
  isLive,
} from './run-vocabulary';
import { StatusDot } from './status-dot';

interface Props {
  run: any;
  user?: User;
}

/**
 * The handback, in the activity feed.
 *
 * A run report is a collaborator saying what they did, which is what this
 * column is for — and it is 640px wide rather than 268px, which is what the
 * report needs. It lands in the feed in the order it happened, so the issue
 * reads as one story rather than as a conversation with a report bolted to the
 * side of it.
 *
 * The same card serves a run in flight. Nothing about the layout changes when
 * the run ends, so watching and reviewing are one thing in two moments rather
 * than two components that must be kept looking alike.
 */
export const RunCard = observer(({ run, user }: Props) => {
  const router = useRouter();
  const { agentRunsStore } = useContextStore();

  const { mutate: cancelRun } = useCancelRunMutation();
  const { mutate: retryRun } = useRetryRunMutation();

  const live = isLive(run.status);

  // Only a live card needs the event stream, and only for its last line. A
  // finished run says what it did in its summary.
  React.useEffect(() => {
    if (live && run.id) {
      agentRunsStore.loadEvents(run.id);
    }
  }, [live, run.id, agentRunsStore]);

  const [, forceTick] = React.useReducer((n: number) => n + 1, 0);
  React.useEffect(() => {
    if (!live) {
      return undefined;
    }
    const timer = setInterval(forceTick, 1000);
    return () => clearInterval(timer);
  }, [live]);

  const result = run.result ?? {};
  const failure = run.failure ? FAILURE_PROSE[run.failure] : undefined;
  const took = duration(run);
  const runHref = workspaceHref(
    router.query.workspaceSlug,
    'agent-runs',
    run.id,
  );

  const events = live ? agentRunsStore.getEvents(run.id) : [];
  const latest = events[events.length - 1];

  return (
    <div className="flex w-full flex-col gap-2 rounded-md bg-grayAlpha-100 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          {getUserIcon(user)}
          <span className="truncate">
            {user?.fullname ?? 'The agent'} {verb(run.status)} this issue
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2 font-mono text-xs text-muted-foreground">
          <StatusDot status={run.status} />
          {took && <span>{took}</span>}
          <ReactTimeAgo date={new Date(run.createdAt)} timeStyle="twitter" />
        </div>
      </div>

      {/* A live run says where it is, not what it concluded — it has not
          concluded anything yet. */}
      {live && (
        <div className="flex min-w-0 flex-col gap-0.5 text-muted-foreground">
          <span>{PHASE_LABEL[latest?.phase] ?? 'Getting started'}</span>
          {latest?.message && (
            <span className="truncate font-mono text-xs">{latest.message}</span>
          )}
        </div>
      )}

      {/* A failed run gets the same room as a successful one. It is the case
          everybody skips and the only one where somebody has to do something
          next. */}
      {failure && (
        <div className="flex flex-col gap-0.5">
          <span>It {failure.what}.</span>
          <span className="text-muted-foreground">{failure.next}</span>
          {run.error && (
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-background/60 p-2 font-mono text-xs whitespace-pre-wrap">
              {run.error}
            </pre>
          )}
        </div>
      )}

      {run.summary && !failure && !live && <p>{run.summary}</p>}

      {(result.filesChanged != null || result.branch || result.costUsd) && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {result.filesChanged != null && (
            <span>
              {result.filesChanged} file{result.filesChanged === 1 ? '' : 's'}
            </span>
          )}
          {result.insertions != null && (
            <span className="text-green-600">+{result.insertions}</span>
          )}
          {result.deletions != null && (
            <span className="text-destructive">−{result.deletions}</span>
          )}
          {result.costUsd != null && (
            <span>${Number(result.costUsd).toFixed(2)}</span>
          )}
          {result.branch && (
            <span className="truncate font-mono">{result.branch}</span>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        {/* One primary action per outcome: the thing the reader opened the
            issue to do. */}
        {result.prUrl && (
          <Button variant="secondary" size="sm" asChild>
            <a href={result.prUrl} target="_blank" rel="noreferrer">
              Review the pull request
            </a>
          </Button>
        )}

        {!result.prUrl && result.worktreePath && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              navigator.clipboard?.writeText(`cd ${result.worktreePath}`)
            }
          >
            Copy cd path
          </Button>
        )}

        {live && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => cancelRun({ runId: run.id })}
          >
            Stop
          </Button>
        )}

        {['FAILED', 'EXPIRED', 'NEEDS_REVIEW'].includes(run.status) && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => retryRun({ runId: run.id })}
          >
            Try again
          </Button>
        )}

        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push(runHref)}
        >
          See what it did
        </Button>
      </div>
    </div>
  );
});

/** What the agent did to this issue, in the tense the reader is reading it in. */
function verb(status: string): string {
  if (isLive(status)) {
    return 'is working on';
  }

  switch (status) {
    case 'SUCCEEDED':
      return 'finished';
    case 'NEEDS_REVIEW':
      return 'needs a hand with';
    case 'CANCELED':
      return 'was stopped on';
    default:
      return 'could not finish';
  }
}

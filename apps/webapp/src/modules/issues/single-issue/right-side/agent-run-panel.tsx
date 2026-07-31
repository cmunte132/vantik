/* eslint-disable @typescript-eslint/no-explicit-any */
import { observer } from 'mobx-react-lite';
import { useRouter } from 'next/router';
import React from 'react';

import { workspaceHref } from 'common/workspace-href';

import { useIssueData } from 'hooks/issues';

import { useContextStore } from 'store/global-context-provider';

import { STATUS_LABEL, duration, isLive } from 'modules/agent-runs/run-vocabulary';
import { StatusDot } from 'modules/agent-runs/status-dot';

/**
 * The agent's state, as one property of the issue.
 *
 * This used to be the whole run report — summary, worktree path, diff stat,
 * model id, four log lines — rendered into a 268px column beside Status and
 * Priority. A run report is not a property, and the path running off the edge
 * was what happened when it was filed as one. The report now lives in the
 * activity feed, at the width a report needs.
 *
 * What is left is deliberately the same shape as every other row here: a mark,
 * a word, a number. It is the permanent anchor — a card that has scrolled away
 * is still one click from the properties.
 */
export const AgentRunPanel = observer(() => {
  const issue = useIssueData();
  const router = useRouter();
  const { agentRunsStore } = useContextStore();

  const run = agentRunsStore.getCurrentRunForIssue(issue?.id);

  // A live run's clock has to tick on its own: no sync event arrives just
  // because a second passed.
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

  const took = duration(run);

  return (
    <>
      <label className="text-xs">Agent</label>

      <button
        type="button"
        onClick={() =>
          router.push(
            workspaceHref(router.query.workspaceSlug, 'agent-runs', run.id),
          )
        }
        className="flex w-full min-w-0 items-center gap-2 rounded p-1.5 pl-0 text-left hover:bg-grayAlpha-100"
      >
        <StatusDot status={run.status} className="ml-1.5" />

        {/* Truncated rather than wrapped: the longest label here is "The
            runner went away", and a rail row that grows to two lines stops
            reading like the rows above it. */}
        <span className="truncate">{STATUS_LABEL[run.status] ?? run.status}</span>

        {took && (
          <span className="shrink-0 text-muted-foreground">· {took}</span>
        )}
      </button>
    </>
  );
});

/* eslint-disable @typescript-eslint/no-explicit-any */
import { observer } from 'mobx-react-lite';
import React from 'react';
import ReactTimeAgo from 'react-time-ago';

import { ResumeCommand } from 'modules/agent-runs/resume-command';

import { useRouter } from 'common/router';
import { workspaceHref } from 'common/workspace-href';

import { useIssueData } from 'hooks/issues';
import { useAllUsers } from 'hooks/users';

import { useContextStore } from 'store/global-context-provider';

import { SessionActivityDialog } from './session-activity-dialog';
import {
  continuedFrom,
  resumeCommand,
  sessionRoute,
  sessionTitle,
  terminalActivity,
} from './session-vocabulary';

/**
 * Every agent session that worked on this issue, from any harness and any
 * channel, in one list: the hosted runs and the terminal sessions together.
 *
 * Shaped like the Agent row above it: a label, then rows that are a line of
 * words and a line of small print. A hosted session opens its run. The section
 * is absent when the issue has no sessions.
 */
export const AgentSessionsPanel = observer(() => {
  const issue = useIssueData();
  const router = useRouter();
  const { agentSessionsStore, agentRunsStore } = useContextStore();
  const { users } = useAllUsers();
  // The session whose terminal activity is open.
  const [activityFor, setActivityFor] = React.useState<any>(null);

  const sessions: any[] = agentSessionsStore.getSessionsForIssue(issue?.id);

  if (sessions.length === 0) {
    return null;
  }

  const byId = new Map(sessions.map((session) => [session.id, session]));
  const actorName = (userId: string) =>
    users.find((user) => user.id === userId)?.fullname ?? 'An agent';

  // Scroll only the panel, and only up or down. scrollIntoView also scrolls
  // each clipped ancestor sideways, which moves the whole page when the
  // window is narrow.
  const showParent = (id: string) => {
    const row = document.getElementById(`agent-session-${id}`);
    const panel = row && scrollParent(row);

    if (!row || !panel) {
      return;
    }

    const top =
      row.getBoundingClientRect().top - panel.getBoundingClientRect().top;
    panel.scrollBy({ top: top - 8, behavior: 'smooth' });
  };

  return (
    <div
      className="flex w-full flex-col items-start"
      role="group"
      aria-label="Sessions"
    >
      <label className="text-xs">Sessions</label>

      <ul className="flex w-full min-w-0 flex-col">
        {sessions.map((session) => {
          const parent = session.parentSessionId
            ? byId.get(session.parentSessionId)
            : undefined;
          const continued = continuedFrom(session, parent);
          const run = session.agentRunId;
          // A connector run ran in a worktree, and omp keys sessions by the
          // directory they ran in.
          const resume = resumeCommand(
            session,
            run
              ? agentRunsStore?.getRunById?.(run)?.result?.worktreePath
              : null,
          );

          const terminal = terminalActivity(session);

          const body = (
            <>
              <span className="truncate">{sessionTitle(session)}</span>

              <span className="flex min-w-0 flex-wrap gap-x-1 text-xs text-muted-foreground">
                <span>{sessionRoute(session)}</span>
                <span>· {actorName(session.actorUserId)}</span>
              </span>

              {terminal && (
                <span className="flex min-w-0 flex-wrap gap-x-1 text-xs text-muted-foreground">
                  <span>
                    {terminal.turns} {terminal.turns === 1 ? 'turn' : 'turns'}{' '}
                    in your terminal
                  </span>
                  <span>
                    · last active{' '}
                    <ReactTimeAgo
                      date={
                        new Date(terminal.lastActiveAt ?? session.lastActiveAt)
                      }
                      timeStyle="twitter"
                    />{' '}
                    ago
                  </span>
                </span>
              )}

              <span className="flex min-w-0 flex-wrap gap-x-1 text-xs text-muted-foreground">
                <span>
                  started{' '}
                  <ReactTimeAgo
                    date={new Date(session.startedAt)}
                    timeStyle="twitter"
                  />
                </span>
                <span>
                  · active{' '}
                  <ReactTimeAgo
                    date={new Date(session.lastActiveAt)}
                    timeStyle="twitter"
                  />
                </span>
              </span>
            </>
          );

          return (
            <li
              key={session.id}
              id={`agent-session-${session.id}`}
              className="flex min-w-0 flex-col"
            >
              {run ? (
                <button
                  type="button"
                  onClick={() =>
                    router.push(
                      workspaceHref(
                        router.query.workspaceSlug,
                        'agent-runs',
                        run,
                      ),
                    )
                  }
                  className="flex w-full min-w-0 flex-col rounded p-1.5 pl-0 text-left hover:bg-grayAlpha-100"
                >
                  {body}
                </button>
              ) : terminal ? (
                <button
                  type="button"
                  onClick={() => setActivityFor(session)}
                  className="flex w-full min-w-0 flex-col rounded p-1.5 pl-0 text-left hover:bg-grayAlpha-100"
                >
                  {body}
                </button>
              ) : (
                <div className="flex w-full min-w-0 flex-col p-1.5 pl-0">
                  {body}
                </div>
              )}

              {resume && <ResumeCommand command={resume} className="pb-1" />}

              {continued && (
                <button
                  type="button"
                  onClick={() => parent && showParent(parent.id)}
                  disabled={!parent}
                  className="w-full truncate pb-1.5 text-left text-xs text-muted-foreground hover:underline disabled:no-underline"
                >
                  {continued}
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {activityFor && (
        <SessionActivityDialog
          session={activityFor}
          open
          setOpen={(value) => !value && setActivityFor(null)}
        />
      )}
    </div>
  );
});

/** The nearest ancestor that scrolls up and down. */
function scrollParent(element: HTMLElement): HTMLElement | null {
  let node = element.parentElement;

  while (node) {
    const { overflowY } = getComputedStyle(node);

    if (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }

    node = node.parentElement;
  }

  return null;
}

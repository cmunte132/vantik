/* eslint-disable @typescript-eslint/no-explicit-any */
import { RiLinkM } from '@remixicon/react';
import { Button } from '@vantikhq/ui/components/button';
import { observer } from 'mobx-react-lite';
import NextLink from 'next/link';
import { useRouter } from 'next/router';
import React from 'react';

import { MainLayout } from 'common/layouts/main-layout';
import { SCOPES } from 'common/scopes';
import { workspaceHref } from 'common/workspace-href';
import { withApplicationStore } from 'common/wrappers/with-application-store';

import { useScope } from 'hooks';
import { useUsersData } from 'hooks/users';

import {
  useCancelRunMutation,
  useExecutors,
  useRetryRunMutation,
} from 'services/agent-runs';

import { useContextStore } from 'store/global-context-provider';

import { Header } from './header';
import { RunTimeline } from './run-timeline';
import {
  FAILURE_PROSE,
  duration,
  isLive,
  whereTheWorkWent,
} from './run-vocabulary';

/**
 * One agent run: what it was working on, how it ended, and what it did.
 *
 * A page rather than a pane, so it has the width to show a transcript and the
 * app keeps one navigation rail rather than two. The order down the page is
 * the order the questions get asked: is it still going, did it work, where is
 * the work, and only then what happened along the way.
 */
export const RunView = withApplicationStore(
  observer(() => {
    useScope(SCOPES.AllIssues);

    const router = useRouter();
    const { workspaceSlug, runId } = router.query;

    const { agentRunsStore, issuesStore } = useContextStore();
    const { users } = useUsersData(false);

    const { data: executors } = useExecutors();

    const { mutate: cancelRun } = useCancelRunMutation();
    const { mutate: retryRun } = useRetryRunMutation();

    const run = agentRunsStore.getRunById(String(runId ?? ''));
    const live = run ? isLive(run.status) : false;

    // Events are read per run rather than for every run at once: a chatty
    // harness writes thousands of lines and one run is on screen.
    React.useEffect(() => {
      if (run?.id) {
        agentRunsStore.loadEvents(run.id);
      }
    }, [run?.id, agentRunsStore]);

    // A live run's clock has to move on its own: no sync event arrives merely
    // because another second passed.
    const [, tick] = React.useReducer((n: number) => n + 1, 0);
    React.useEffect(() => {
      if (!live) {
        return undefined;
      }
      const timer = setInterval(tick, 1000);
      return () => clearInterval(timer);
    }, [live]);

    if (!run) {
      return (
        <MainLayout
          header={
            <Header
              crumbs={[
                {
                  title: 'Agents',
                  href: workspaceHref(workspaceSlug, 'agent-runs'),
                },
                { title: 'Run' },
              ]}
            />
          }
        >
          <p className="p-4 text-muted-foreground">No run found.</p>
        </MainLayout>
      );
    }

    const issue = issuesStore?.getIssueById?.(run.issueId);
    const events = agentRunsStore.getEvents(run.id);
    const where = whereTheWorkWent(run.result ?? {});
    const failure = run.failure ? FAILURE_PROSE[run.failure] : undefined;
    // Absent is ordinary: an agent minted moments before it runs is not in the
    // cached membership list yet, and a removed one never will be.
    const agent = users?.find((user: any) => user.id === run.agentUserId);

    return (
      <MainLayout
        scrollable
        header={
          <Header
            crumbs={[
              {
                title: 'Agents',
                href: workspaceHref(workspaceSlug, 'agent-runs'),
              },
              { title: issue?.title ?? 'Run' },
            ]}
            actions={
              <div className="flex items-center gap-2">
                {issue && (
                  <Button variant="secondary" size="sm" asChild>
                    <NextLink
                      href={workspaceHref(
                        workspaceSlug,
                        'issue',
                        String(issue.number),
                      )}
                    >
                      Open issue
                    </NextLink>
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

                {/* Retry only where the server allows it. Re-running a success
                    would open a second pull request for the same work. */}
                {['FAILED', 'EXPIRED', 'NEEDS_REVIEW'].includes(run.status) && (
                  <Button size="sm" onClick={() => retryRun({ runId: run.id })}>
                    Retry
                  </Button>
                )}
              </div>
            }
          />
        }
      >
        <div className="flex max-w-3xl flex-col gap-4 p-4">
          {/* The outcome as a sentence. Four grey pills of equal weight rank
              nothing, and ranking is the entire job of the top of this page. */}
          <h1 className="text-lg leading-snug font-medium">
            {verdict(run, agent?.fullname, failure)}
          </h1>

          {/* The identifiers drop below it. They are what makes two runs of one
              issue tellable apart afterwards, which is a different question
              from the one a reader arrives with. */}
          <p className="text-muted-foreground">
            {[
              duration(run),
              run.iterationCount
                ? `${run.iterationCount} iteration${run.iterationCount === 1 ? '' : 's'}`
                : '',
              run.result?.costUsd != null
                ? `$${Number(run.result.costUsd).toFixed(2)}`
                : '',
              run.attempt > 1 ? `attempt ${run.attempt}` : '',
            ]
              .filter(Boolean)
              .join(' · ')}
            {run.modelId ? (
              <>
                {' · '}
                <span className="font-mono">{run.modelId}</span>
              </>
            ) : null}
            {` on ${executorLabel(executors, run.executor)}`}
          </p>

          {/* Where the work went is why most people opened this page, so it is
              a target above the timeline rather than a bordered box below it. */}
          {(where || live) && (
            <div className="flex flex-wrap items-center gap-2">
              {where?.kind === 'pull_request' && (
                <Button size="sm" asChild>
                  <a href={where.value} target="_blank" rel="noreferrer">
                    <RiLinkM className="mr-1 size-3.5" size={18} />
                    Review the pull request
                  </a>
                </Button>
              )}

              {where?.kind === 'worktree' && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    navigator.clipboard?.writeText(`cd ${where.value}`)
                  }
                >
                  Copy cd path
                </Button>
              )}

              {/* Beside the pull request rather than instead of it: a reviewer
                  opens the PR, and somebody pulling the work locally wants the
                  branch. The raw url is not shown — the button is the target,
                  and a wrapped git url is just noise under it. */}
              {run.result?.branch && where?.kind !== 'worktree' && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    navigator.clipboard?.writeText(run.result.branch)
                  }
                >
                  Copy branch
                </Button>
              )}
            </div>
          )}

          {failure && (
            <div className="flex flex-col gap-1 rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <p className="text-destructive">
                This run stopped because {failure.what}.
              </p>
              <p className="text-muted-foreground">{failure.next}</p>
            </div>
          )}

          {run.summary && <p className="whitespace-pre-wrap">{run.summary}</p>}

          <div className="border-t border-border pt-2">
            <RunTimeline run={run} events={events} />
          </div>
        </div>
      </MainLayout>
    );
  }),
);

/**
 * The executor as a person would name it, not as a key.
 *
 * Read from the executors endpoint rather than from a table copied into this
 * bundle: the server already publishes a label per backend, and a second copy
 * here would be the one that goes stale when a backend is added.
 */
function executorLabel(executors: any, key: string): string {
  return (
    ((executors as any[]) ?? []).find((entry: any) => entry.key === key)
      ?.label ?? key
  ).toLowerCase();
}

/**
 * How the run ended, in one line.
 *
 * Written rather than composed from a status enum, because the sentence a
 * reader needs is not the same for a run that is still going, one that
 * produced a pull request, and one that stopped at a ceiling.
 */
function verdict(
  run: any,
  agentName: string | undefined,
  failure?: { what: string },
): string {
  const who = agentName ?? 'The agent';

  if (isLive(run.status)) {
    return `${who} is working on this.`;
  }

  if (failure) {
    return `${who} could not finish — ${failure.what}.`;
  }

  switch (run.status) {
    case 'SUCCEEDED':
      return run.result?.prUrl
        ? `${who} finished and opened a pull request.`
        : `${who} finished the work.`;
    case 'NEEDS_REVIEW':
      return `${who} finished, but somebody has to judge whether it is right.`;
    case 'CANCELED':
      return `${who} was stopped before it finished.`;
    default:
      return `${who} could not finish this run.`;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Badge } from '@vantikhq/ui/components/badge';
import { Button } from '@vantikhq/ui/components/button';
import { LinkLine } from '@vantikhq/ui/icons';
import { cn } from '@vantikhq/ui/lib/utils';
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

import { useCancelRunMutation, useRetryRunMutation } from 'services/agent-runs';

import { useContextStore } from 'store/global-context-provider';

import { Header } from './header';
import { RunTimeline } from './run-timeline';
import {
  FAILURE_PROSE,
  STATUS_LABEL,
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
                {['FAILED', 'EXPIRED', 'NEEDS_REVIEW'].includes(
                  run.status,
                ) && (
                  <Button size="sm" onClick={() => retryRun({ runId: run.id })}>
                    Retry
                  </Button>
                )}
              </div>
            }
          />
        }
      >
        <div className="flex max-w-3xl flex-col gap-6 p-4">
          <div className="flex flex-col gap-2">
            {/* Everything a run has to carry for two runs of one issue to be
                told apart afterwards. */}
            <div className="flex flex-wrap items-center gap-1">
              <Badge
                variant={failure ? 'destructive' : 'secondary'}
                className={cn(live && 'animate-pulse')}
              >
                {STATUS_LABEL[run.status] ?? run.status}
              </Badge>

              <Badge variant="secondary">{run.executor}</Badge>
              {run.modelId && <Badge variant="secondary">{run.modelId}</Badge>}
              {run.harnessVersion && (
                <Badge variant="secondary">{run.harnessVersion}</Badge>
              )}
              {run.attempt > 1 && (
                <Badge variant="secondary">attempt {run.attempt}</Badge>
              )}
            </div>

            <p className="text-muted-foreground">
              {agent?.fullname ?? 'An agent'}
              {duration(run) ? ` · ${duration(run)}` : ''}
              {run.iterationCount
                ? ` · ${run.iterationCount} iteration${run.iterationCount === 1 ? '' : 's'}`
                : ''}
            </p>
          </div>

          {failure && (
            <div className="flex flex-col gap-1 rounded-md border border-destructive/30 bg-destructive/5 p-3">
              <p className="text-destructive">
                This run stopped because {failure.what}.
              </p>
              <p className="text-muted-foreground">{failure.next}</p>
            </div>
          )}

          {run.summary && (
            <Block title="What it says it did">
              <p className="whitespace-pre-wrap p-3">{run.summary}</p>
            </Block>
          )}

          {where && (
            <Block title="Where the work went">
              <div className="p-3">
                <WorkLocation where={where} />
              </div>
            </Block>
          )}

          <Block title="What it did">
            <RunTimeline run={run} events={events} />
          </Block>
        </div>
      </MainLayout>
    );
  }),
);

/** A titled block, in the shape the product and module pages use. */
function Block({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-medium">{title}</h2>
      <div className="rounded-md border border-border">{children}</div>
    </section>
  );
}

function WorkLocation({
  where,
}: {
  where: { kind: string; value: string };
}): React.ReactElement {
  if (where.kind === 'pull_request') {
    return (
      <a
        href={where.value}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-2 text-primary hover:underline"
      >
        <LinkLine className="size-3.5 shrink-0" />
        {where.value}
      </a>
    );
  }

  // Selectable, because the only useful thing to do with a path is copy it.
  return (
    <code className="select-all font-mono text-xs">
      {where.kind === 'worktree' ? `cd ${where.value}` : where.value}
    </code>
  );
}

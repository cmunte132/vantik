/* eslint-disable @typescript-eslint/no-explicit-any */
import { AGENT_RUN_DEFAULT_LIMITS } from '@vantikhq/types';
import { getInitials } from '@vantikhq/ui/components/avatar';
import { Button } from '@vantikhq/ui/components/button';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import React from 'react';

import { AgentQuestionCard } from 'modules/agent-questions/agent-question-card';

import { MainLayout } from 'common/layouts/main-layout';
import { Link as RouterLink, useRouter } from 'common/router';
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

import { CleanUpRun } from './clean-up-run';
import { Header } from './header';
import { RunActivity } from './run-activity';
import {
  changesOf,
  clock,
  inFlight,
  runStart,
  stagesOf,
  toFeed,
  toSteps,
} from './run-feed';
import {
  Changes,
  DefinitionOfDone,
  NowCard,
  OutcomeCard,
  RunFacts,
  SpendCard,
  Stepper,
} from './run-parts';
import {
  failureProse,
  STATUS_LABEL,
  costOf,
  isLive,
  shownStatus,
} from './run-vocabulary';

/**
 * One agent run: who is working on what, where it is, and what it did.
 *
 * The order down the page is the order the questions get asked. Is it still
 * going, and how far along — the header and the five stages. What is it doing
 * now, or how did it end — the Now card, which becomes the outcome card. Then
 * the activity feed, for anyone who wants the detail. The rail on the right
 * holds what the run is measured against and what it changed.
 */
export const RunView = withApplicationStore(
  observer(() => {
    useScope(SCOPES.AllIssues);

    const router = useRouter();
    const { workspaceSlug, runId } = router.query;

    const {
      agentRunsStore,
      agentQuestionsStore,
      issuesStore,
      teamsStore,
      checklistItemsStore,
    } = useContextStore();
    const { users } = useUsersData(false);

    const { data: executors } = useExecutors();

    const { mutate: cancelRun } = useCancelRunMutation();
    // A retry is a new run with its own page; go there, or the button looks
    // as if it did nothing.
    const { mutate: retryRun } = useRetryRunMutation({
      onSuccess: (next) =>
        router.push(workspaceHref(workspaceSlug, 'agent-runs', next.id)),
    });

    const run = agentRunsStore.getRunById(String(runId ?? ''));
    const live = run ? isLive(run.status) : false;

    // Events are read per run rather than for every run at once: a chatty
    // harness writes thousands of lines and one run is on screen.
    React.useEffect(() => {
      if (run?.id) {
        agentRunsStore.loadEvents(run.id);
      }
    }, [run?.id, agentRunsStore]);

    // The Definition of Done lives on the issue, and its items load per issue.
    React.useEffect(() => {
      if (run?.issueId) {
        checklistItemsStore?.load?.(run.issueId);
      }
    }, [run?.issueId, checklistItemsStore]);

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

    const now = Date.now();
    const issue = issuesStore?.getIssueById?.(run.issueId);
    const team = issue && teamsStore?.getTeamWithId?.(issue.teamId);
    const issueKey = team && issue ? `${team.identifier}-${issue.number}` : '';
    const openQuestions = (agentQuestionsStore.openQuestions as any[]).filter(
      (question) => question.agentRunId === run.id,
    );
    const events = agentRunsStore.getEvents(run.id);
    const feed = toFeed(events);
    const current = inFlight(run, feed);
    const stages = stagesOf(run, events, now);
    const files = changesOf(toSteps(events));
    const criteria =
      checklistItemsStore?.getChecklistItems?.(run.issueId) ?? [];
    const failure = failureProse(run);
    const start = runStart(run);
    const ended = run.finishedAt ? Date.parse(run.finishedAt) : null;
    const took = live ? now - start : ended ? ended - start : null;
    // Absent is ordinary: an agent minted moments before it runs is not in the
    // cached membership list yet, and a removed one never will be.
    const agent = users?.find((user: any) => user.id === run.agentUserId);
    const agentName = agent?.fullname ?? 'Agent';
    const model = run.modelId ?? run.config?.model;
    const runner = executorLabel(executors, run.executor);
    // Every attempt at one issue is the same agent, so its spend is the sum of
    // them. Shown only when there is more than this one run to add up.
    const attempts = agentRunsStore
      .getRunsForIssue(run.issueId)
      .filter((each: any) => each.agentUserId === run.agentUserId);
    const agentTotal =
      attempts.length > 1
        ? {
            costUsd: attempts.reduce(
              (sum: number, each: any) => sum + (costOf(each) ?? 0),
              0,
            ),
            runs: attempts.length,
          }
        : undefined;

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
                {issueKey && (
                  <Button variant="secondary" size="sm" asChild>
                    <RouterLink
                      href={workspaceHref(workspaceSlug, 'issue', issueKey)}
                    >
                      Open issue
                    </RouterLink>
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

                <CleanUpRun
                  run={run}
                  onRetry={() => retryRun({ runId: run.id })}
                />

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
        <div className="grid grid-cols-1 gap-10 px-4 pt-7 pb-10 md:px-10 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="flex max-w-[780px] min-w-0 flex-col gap-[22px]">
            <div className="flex flex-col gap-3.5">
              <div className="flex items-center gap-3">
                <span className="relative size-[34px] shrink-0">
                  {live && (
                    <span className="absolute inset-0 animate-ping rounded-full bg-primary/30" />
                  )}
                  <span className="relative grid size-full place-items-center rounded-full bg-primary text-sm font-semibold text-white">
                    {getInitials(agentName)}
                  </span>
                </span>

                <div className="flex min-w-0 grow flex-col">
                  <span className="truncate font-semibold">{agentName}</span>
                  <span className="truncate text-muted-foreground">
                    {[
                      issueKey,
                      model,
                      runner,
                      run.attempt > 1 ? `attempt ${run.attempt}` : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>

                <StatusPill
                  status={shownStatus(run)}
                  failed={Boolean(failure)}
                  took={took}
                />
              </div>

              <h1 className="text-xl leading-snug font-semibold tracking-tight">
                {issue?.title ?? 'Agent run'}
              </h1>

              <Stepper stages={stages} />
            </div>

            {live ? (
              current && <NowCard item={current} now={now} />
            ) : (
              <OutcomeCard
                run={run}
                failure={failure}
                feed={feed}
                cleanedUpBy={
                  users?.find(
                    (user: any) => user.id === run.result?.cleanedUp?.byUserId,
                  )?.fullname
                }
              />
            )}

            {/* An open question blocks the run, so its form sits above the
                feed instead of in it. The feed shows the answered card. */}
            {openQuestions.map((question: any) => (
              <AgentQuestionCard
                key={question.id}
                questionId={question.id}
                hideIssue
              />
            ))}

            <RunActivity
              feed={feed}
              start={start}
              current={current}
              agentName={agentName}
              live={live}
              setupMs={
                (run.phaseTimings as Record<string, number> | null)?.setup
              }
            />
          </div>

          <aside className="flex min-w-0 flex-col gap-4">
            <SpendCard
              costUsd={costOf(run)}
              budgetUsd={budgetOf(run)}
              turns={
                typeof run.result?.turns === 'number'
                  ? run.result.turns
                  : undefined
              }
              passes={run.iterationCount || undefined}
              live={live}
              agentTotal={agentTotal}
            />
            {criteria.length > 0 && <DefinitionOfDone items={criteria} />}
            {files.length > 0 && <Changes files={files} />}
            <RunFacts
              facts={[
                ...(model
                  ? [{ label: 'Model', value: model, mono: true }]
                  : []),
                { label: 'Runner', value: runner },
                ...(run.config?.thinking
                  ? [{ label: 'Thinking', value: String(run.config.thinking) }]
                  : []),
                ...(run.result?.branch
                  ? [{ label: 'Branch', value: run.result.branch, mono: true }]
                  : []),
                // Neutral on purpose: the id, not a link into one vendor's
                // backend. Paste it into whichever one the deployment uses.
                ...(run.traceId
                  ? [{ label: 'Trace', value: run.traceId, mono: true }]
                  : []),
              ]}
            />
          </aside>
        </div>
      </MainLayout>
    );
  }),
);

/**
 * The most the run may spend.
 *
 * The same resolution the server's cycle makes: the run's own ceiling when it
 * set a positive one, otherwise the default.
 */
function budgetOf(run: any): number {
  const set = run.config?.limits?.maxCostUsd;

  return typeof set === 'number' && set > 0
    ? set
    : AGENT_RUN_DEFAULT_LIMITS.maxCostUsd;
}

/** The run's state in a word, and how long it has taken. */
const StatusPill = ({
  status,
  failed,
  took,
}: {
  status: string;
  failed: boolean;
  took: number | null;
}) => {
  const tone = isLive(status)
    ? 'bg-primary/15 text-primary'
    : status === 'SUCCEEDED'
      ? 'bg-success/15 text-success'
      : status === 'NEEDS_REVIEW'
        ? 'bg-warning/15 text-warning'
        : failed || status === 'FAILED' || status === 'EXPIRED'
          ? 'bg-destructive/15 text-destructive'
          : 'bg-grayAlpha-100 text-muted-foreground';

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 font-medium',
        tone,
      )}
    >
      <span className="size-[7px] rounded-full bg-current" />
      {STATUS_LABEL[status] ?? status}
      {took != null && (
        <span className="font-mono font-normal opacity-80">{clock(took)}</span>
      )}
    </span>
  );
};

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

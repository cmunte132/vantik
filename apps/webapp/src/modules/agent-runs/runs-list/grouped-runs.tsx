/* eslint-disable @typescript-eslint/no-explicit-any */
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import NextLink from 'next/link';
import { useRouter } from 'next/router';
import React from 'react';

import { workspaceHref } from 'common/workspace-href';

import { useContextStore } from 'store/global-context-provider';

import {
  FAILURE_PROSE,
  STATUS_LABEL,
  age,
  duration,
  whereTheWorkWent,
} from '../run-vocabulary';
import { StatusDot } from '../status-dot';
import {
  type RunGroup,
  groupRunsByIssue,
  sentenceCase,
  shortModel,
} from './group-runs';

/**
 * Every agent run in the workspace, grouped by the issue it was working on.
 *
 * Drawn here rather than through `RecordTable` — the table the products and
 * teams lists share — because that component renders flat rows and has no
 * notion of a group heading. The divergence is the point of the screen: an
 * issue's four attempts have to read as one issue's history, and a flat table
 * can only ever show them as four unrelated rows sorted by date.
 *
 * The issue is named once per group, at full width, so nothing is truncated.
 * Every column in the rows underneath answers exactly one question about the
 * run, which the old `modelId ?? executor` column did not.
 */
export const GroupedRuns = observer(({ runs }: { runs: any[] }) => {
  const { issuesStore, teamsStore } = useContextStore();

  // Not memoised: `runs` is copied out of the MST array on every render, so it
  // is a new reference every time and a dependency array on it would recompute
  // anyway while reading as though it did not.
  const groups = groupRunsByIssue(runs, (issueId: string) => {
    const issue = issuesStore?.getIssueById?.(issueId);
    const team = issue && teamsStore?.getTeamWithId?.(issue.teamId);

    return {
      key: team ? `${team.identifier}-${issue.number}` : null,
      title: issue?.title ?? 'Deleted issue',
      ...(issue?.number != null ? { number: issue.number } : {}),
    };
  });

  if (groups.length === 0) {
    return (
      <p className="p-6 text-muted-foreground">
        No agent runs yet. Open an issue and delegate it to an agent.
      </p>
    );
  }

  return (
    <div className="flex flex-col">
      {groups.map((group: RunGroup) => (
        <Group key={group.issueId} group={group} />
      ))}
    </div>
  );
});

const Group = observer(({ group }: { group: RunGroup }) => {
  const router = useRouter();
  const { workspaceSlug } = router.query;

  const count = group.runs.length;

  return (
    <section className="border-b border-border last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 px-3 pt-3 pb-1.5">
        {/* The heading names the work; a row underneath names one attempt at
            it. Both are worth reaching, so both are links — this one to the
            issue, the rows to their run. */}
        {group.issue.number != null ? (
          <NextLink
            href={workspaceHref(
              workspaceSlug,
              'issue',
              String(group.issue.number),
            )}
            className="flex min-w-0 items-baseline gap-2.5 hover:underline"
          >
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {group.issue.key}
            </span>
            <span className="font-medium">{group.issue.title}</span>
          </NextLink>
        ) : (
          // Full width and unclipped — the whole reason the issue moved out of
          // the rows.
          <span className="font-medium">{group.issue.title}</span>
        )}

        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {count} run{count === 1 ? '' : 's'}
          {group.latestAt ? ` · last ${age(group.latestAt)} ago` : ''}
        </span>
      </div>

      <div className="flex flex-col pb-1.5">
        {group.runs.map(({ run, ordinal }) => (
          <Row
            key={run.id}
            run={run}
            ordinal={ordinal}
            onOpen={() =>
              router.push(workspaceHref(workspaceSlug, 'agent-runs', run.id))
            }
          />
        ))}
      </div>
    </section>
  );
});

const Row = observer(
  ({
    run,
    ordinal,
    onOpen,
  }: {
    run: any;
    ordinal: number;
    onOpen: () => void;
  }) => {
    const failure = run.failure ? FAILURE_PROSE[run.failure] : undefined;
    const where = whereTheWorkWent(run.result ?? {});
    const took = duration(run);

    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen();
          }
        }}
        className="flex cursor-default items-center gap-3 rounded px-3 py-1.5 hover:bg-grayAlpha-100 focus-visible:ring-1 focus-visible:ring-primary focus-visible:outline-none"
      >
        {/* Which run this is on the issue. The cheapest column on the row and
            the one that makes four rows read as a history. */}
        <span className="w-7 shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
          #{ordinal}
        </span>

        <span
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2',
            failure && 'text-destructive',
          )}
        >
          <StatusDot status={run.status} />
          <span className="truncate">
            {failure
              ? sentenceCase(failure.short)
              : (STATUS_LABEL[run.status] ?? run.status)}
          </span>
        </span>

        {/* The model, always — never silently substituting the executor, which
            answered a different question depending on how far the run got. */}
        <span className="hidden w-40 shrink-0 truncate font-mono text-xs text-muted-foreground sm:block">
          {run.modelId ? shortModel(run.modelId) : '—'}
        </span>

        <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
          {took || '—'}
        </span>

        <span className="hidden w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums md:block">
          {age(run.createdAt)} ago
        </span>

        {/* Only when there is work, so the rows that produced something are the
            rows with something at the edge. */}
        <span className="hidden w-56 shrink-0 justify-end lg:flex">
          {where && (
            <NextLink
              href={where.kind === 'pull_request' ? where.value : '#'}
              onClick={(event) => {
                event.stopPropagation();
                if (where.kind !== 'pull_request') {
                  event.preventDefault();
                  onOpen();
                }
              }}
              target={where.kind === 'pull_request' ? '_blank' : undefined}
              rel={where.kind === 'pull_request' ? 'noreferrer' : undefined}
              className="truncate font-mono text-xs text-primary hover:underline"
            >
              {tail(where.value)} →
            </NextLink>
          )}
        </span>
      </div>
    );
  },
);

/** Enough of a path or url to recognise it, from the end that identifies it. */
function tail(value: string): string {
  return value.split('/').filter(Boolean).slice(-2).join('/') || value;
}

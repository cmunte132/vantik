'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { type ColumnDef } from '@tanstack/react-table';
import { Badge } from '@vantikhq/ui/components/badge';
import { cn } from '@vantikhq/ui/lib/utils';
import * as React from 'react';

import { useContextStore } from 'store/global-context-provider';

import {
  FAILURE_PROSE,
  STATUS_LABEL,
  age,
  duration,
  isLive,
  whereTheWorkWent,
} from '../run-vocabulary';

/**
 * The columns of the runs list.
 *
 * One row per attempt, and the columns are the questions asked of a run in the
 * order they are asked: what was it working on, how did it end, where did the
 * work go, what drove it, how long did it take, and when. A run that failed
 * names its failure here, so the list answers "what went wrong" without
 * anybody opening a row.
 */
export const useRunColumns = (): Array<ColumnDef<any>> => {
  const { issuesStore, teamsStore } = useContextStore();

  return [
    {
      accessorKey: 'issue',
      header: () => <span className="px-4">Issue</span>,
      cell: ({ row }) => {
        const issue = issuesStore?.getIssueById?.(row.original.issueId);
        const team = issue && teamsStore?.getTeamWithId?.(issue.teamId);

        return (
          <div className="flex max-w-[14rem] items-center gap-2 py-2 pl-4 lg:max-w-[20rem] xl:max-w-[26rem]">
            <StatusDot status={row.original.status} />

            {/* The key first. Several attempts at one issue are the ordinary
                case, and a column of identical titles is unreadable without
                something short in front of them. */}
            {team && (
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {team.identifier}-{issue.number}
              </span>
            )}

            <span className="truncate">{issue?.title ?? 'Deleted issue'}</span>

            {row.original.attempt > 1 && (
              <Badge variant="secondary" className="shrink-0">
                attempt {row.original.attempt}
              </Badge>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: 'status',
      header: () => <span className="whitespace-nowrap px-4">Outcome</span>,
      cell: ({ row }) => (
        <div
          className={cn(
            'flex items-center gap-1 py-2 pl-4 whitespace-nowrap',
            row.original.failure && 'text-destructive',
          )}
        >
          {row.original.failure
            ? (FAILURE_PROSE[row.original.failure]?.short ??
              row.original.failure)
            : (STATUS_LABEL[row.original.status] ?? row.original.status)}
        </div>
      ),
    },
    {
      accessorKey: 'result',
      header: () => <span className="whitespace-nowrap px-4">Work</span>,
      cell: ({ row }) => {
        const where = whereTheWorkWent(row.original.result ?? {});

        return (
          <div className="flex items-center gap-1 py-2 pl-4 text-muted-foreground">
            {where ? (
              <span className="truncate font-mono text-xs">
                {tail(where.value)}
              </span>
            ) : (
              '—'
            )}
          </div>
        );
      },
    },
    {
      accessorKey: 'modelId',
      header: () => <span className="whitespace-nowrap px-4">Driven by</span>,
      cell: ({ row }) => (
        <div className="flex items-center gap-1 py-2 pl-4 text-muted-foreground whitespace-nowrap">
          {row.original.modelId ?? row.original.executor}
        </div>
      ),
    },
    {
      accessorKey: 'took',
      header: () => <span className="whitespace-nowrap px-4">Took</span>,
      cell: ({ row }) => (
        <div className="flex items-center gap-1 py-2 pl-4 text-muted-foreground whitespace-nowrap">
          {duration(row.original) || '—'}
        </div>
      ),
    },
    {
      accessorKey: 'createdAt',
      header: () => <span className="whitespace-nowrap px-4">When</span>,
      cell: ({ row }) => (
        <div className="flex items-center gap-1 py-2 pl-4 pr-4 text-muted-foreground whitespace-nowrap">
          {age(row.original.createdAt)}
        </div>
      ),
    },
  ];
};

export const StatusDot = ({
  status,
  className,
}: {
  status: string;
  className?: string;
}) => (
  <span
    className={cn(
      'size-2 shrink-0 rounded-full',
      isLive(status) && 'animate-pulse bg-primary',
      status === 'SUCCEEDED' && 'bg-green-500',
      status === 'NEEDS_REVIEW' && 'bg-amber-500',
      ['FAILED', 'EXPIRED'].includes(status) && 'bg-destructive',
      status === 'CANCELED' && 'bg-muted-foreground',
      className,
    )}
  />
);

/** Enough of a path or url to recognise it, from the end that identifies it. */
function tail(value: string): string {
  return value.split('/').filter(Boolean).slice(-2).join('/') || value;
}

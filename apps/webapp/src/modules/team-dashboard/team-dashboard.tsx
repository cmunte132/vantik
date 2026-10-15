import type {
  Burndown,
  StuckIssueWithFinding,
  TeamDashboardMetrics,
} from '@vantikhq/types';

import { AvatarText } from '@vantikhq/ui/components/avatar';
import { Badge } from '@vantikhq/ui/components/badge';
import { Button } from '@vantikhq/ui/components/button';
import { Loader } from '@vantikhq/ui/components/loader';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { Header } from 'modules/issues/all/header';

import { AppLayout } from 'common/layouts/app-layout';
import { MainLayout } from 'common/layouts/main-layout';
import { Link, useRouter } from 'common/router';
import type { TeamType, User } from 'common/types';
import { withApplicationStore } from 'common/wrappers/with-application-store';

import { useCurrentTeam } from 'hooks/teams';
import { useUsersData } from 'hooks/users';

import {
  useDashboardMetricsQuery,
  useStuckIssuesQuery,
} from 'services/team-dashboard';

import { useContextStore } from 'store/global-context-provider';

import { BarChart, LineChart } from './charts';
import {
  formatAgo,
  formatHours,
  formatUntil,
  shortDate,
  shortWeek,
  weeklyComparison,
} from './utils';

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between min-h-[28px]">
        <h3 className="text-sm font-medium">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-lg">{value}</span>
      {hint && <span className="text-muted-foreground">{hint}</span>}
    </div>
  );
}

function burndownProgress(burndown: Burndown | null) {
  if (!burndown || burndown.actual.length === 0) {
    return null;
  }

  // Scope can grow mid-cycle, so the total is the peak, not the first day.
  const total = Math.max(...burndown.actual.map((day) => day.remaining));
  if (total <= 0) {
    return { percent: null, burndown };
  }

  const remaining = burndown.actual[burndown.actual.length - 1].remaining;
  const percent = Math.round(((total - remaining) / total) * 100);

  return { percent: Math.min(100, Math.max(0, percent)), burndown };
}

function StatRow({ metrics }: { metrics: TeamDashboardMetrics }) {
  const { current, previous, delta } = weeklyComparison(
    metrics.velocity.weekly,
  );
  const progress = burndownProgress(metrics.burndown);
  const sign = delta > 0 ? '+' : '';

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <Stat
        label="Completed this week"
        value={String(current)}
        hint={`${sign}${delta} vs ${previous} last week`}
      />
      <Stat
        label="Median cycle time"
        value={formatHours(metrics.cycleTime.medianHours)}
        hint={
          metrics.cycleTime.sampleCount > 0
            ? `from ${metrics.cycleTime.sampleCount} issues`
            : 'Not enough history yet'
        }
      />
      <Stat
        label="Current cycle"
        value={
          progress && progress.percent !== null ? `${progress.percent}%` : '–'
        }
        hint={
          progress
            ? `${progress.burndown.name || `Cycle ${progress.burndown.number}`} done`
            : 'No active cycle'
        }
      />
    </div>
  );
}

function VelocityChart({ metrics }: { metrics: TeamDashboardMetrics }) {
  const [mode, setMode] = React.useState<'weekly' | 'cycles'>('weekly');
  const { weekly, cycles } = metrics.velocity;
  const hasCycles = cycles.length > 0;
  const view = hasCycles ? mode : 'weekly';

  const recentCycles = cycles.slice(-8);
  const usePoints =
    view === 'weekly'
      ? weekly.some((w) => w.points > 0)
      : recentCycles.some((c) => c.completedPoints > 0);
  const unit = usePoints ? 'points' : 'issues';

  const data =
    view === 'weekly'
      ? weekly.map((w) => {
          const value = usePoints ? w.points : w.count;

          return {
            label: shortWeek(w.week),
            value,
            title: `${w.week}: ${value} ${unit} completed`,
          };
        })
      : recentCycles.map((c) => {
          const value = usePoints ? c.completedPoints : c.completedCount;

          return {
            label: `#${c.number}`,
            value,
            title: `${c.name || `Cycle ${c.number}`}: ${value} of ${
              usePoints ? c.totalPoints : c.totalCount
            } ${unit} completed`,
          };
        });

  return (
    <Section
      title={`Velocity (${unit} completed)`}
      aside={
        hasCycles && (
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              isActive={view === 'weekly'}
              onClick={() => setMode('weekly')}
            >
              Weekly
            </Button>
            <Button
              variant="ghost"
              size="sm"
              isActive={view === 'cycles'}
              onClick={() => setMode('cycles')}
            >
              Per cycle
            </Button>
          </div>
        )
      }
    >
      {data.length > 0 ? (
        <BarChart data={data} />
      ) : (
        <p className="text-muted-foreground">Nothing completed yet.</p>
      )}
    </Section>
  );
}

function BurndownChart({ burndown }: { burndown: Burndown | null }) {
  return (
    <Section
      title={
        burndown
          ? `Burndown, ${burndown.name || `Cycle ${burndown.number}`} (${burndown.unit} remaining)`
          : 'Burndown'
      }
    >
      {burndown ? (
        <LineChart
          unit={burndown.unit}
          actual={burndown.actual.map((d) => ({
            label: shortDate(d.date),
            value: d.remaining,
          }))}
          ideal={burndown.ideal.map((d) => ({
            label: shortDate(d.date),
            value: d.remaining,
          }))}
        />
      ) : (
        <p className="text-muted-foreground">No active cycle</p>
      )}
    </Section>
  );
}

const CATEGORY_LABELS: Record<string, string> = {
  'waiting-on-review': 'Waiting on review',
  'blocked-by-dependency': 'Blocked',
  'unclear-scope': 'Unclear scope',
  'too-large': 'Too large',
  'no-owner': 'No owner',
  inactive: 'Inactive',
  other: 'Other',
};

const StuckRow = observer(
  ({
    item,
    team,
    users,
  }: {
    item: StuckIssueWithFinding;
    team: TeamType;
    users: User[];
  }) => {
    const { workflowsStore } = useContextStore();
    const { query } = useRouter();
    const state = workflowsStore.getWorkflowWithId(item.stateId);
    const assignee = item.assigneeId
      ? users.find((user) => user.id === item.assigneeId)
      : undefined;
    const key = `${team.identifier}-${item.number}`;
    const { finding } = item;

    return (
      <li className="flex flex-col gap-1.5 py-3 border-b border-border last:border-b-0">
        <div className="flex items-center justify-between gap-4">
          <Link
            href={`/${query.workspaceSlug}/issue/${key}`}
            className="flex gap-2 min-w-0 hover:underline"
          >
            <span className="text-muted-foreground shrink-0">{key}</span>
            <span className="truncate">{item.title}</span>
          </Link>

          <div className="flex items-center gap-2 shrink-0">
            {assignee ? (
              <AvatarText text={assignee.fullname} className="text-[9px]" />
            ) : (
              <span className="text-muted-foreground">Unassigned</span>
            )}
          </div>
        </div>

        <div className="text-muted-foreground">
          {state?.name ?? 'Unknown state'} · {formatHours(item.hoursInState)} of{' '}
          {formatHours(item.thresholdHours)}{' '}
          <span className="text-[11px]">({item.thresholdSource})</span>
        </div>

        {finding ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-start gap-2">
              <Badge variant="secondary" className="shrink-0">
                {CATEGORY_LABELS[finding.category] ?? finding.category}
              </Badge>
              <span>{finding.cause}</span>
            </div>
            {finding.suggestions.length > 0 && (
              <ul className="list-disc pl-5 text-muted-foreground">
                {finding.suggestions.map((suggestion) => (
                  <li key={suggestion}>{suggestion}</li>
                ))}
              </ul>
            )}
            <span className="text-muted-foreground text-[11px]">
              Analysed {formatAgo(finding.analyzedAt)}
            </span>
          </div>
        ) : (
          <span className="text-muted-foreground">Analysis pending</span>
        )}
      </li>
    );
  },
);

const NeedsAttention = observer(({ team }: { team: TeamType }) => {
  const { data, isLoading, isError } = useStuckIssuesQuery(team.id);
  const { users } = useUsersData(true);

  const items = React.useMemo(
    () =>
      [...(data?.items ?? [])].sort((a, b) => b.overageHours - a.overageHours),
    [data],
  );

  const analysis = data?.analysis;
  const status = analysis?.lastAnalysisAt
    ? `Last analysed ${formatAgo(analysis.lastAnalysisAt)}${
        analysis.nextAnalysisAt
          ? ` · next run in ${formatUntil(analysis.nextAnalysisAt)}`
          : ''
      }`
    : 'Analysis runs when the team is active';

  return (
    <Section title="Needs attention">
      {data && <p className="text-muted-foreground">{status}</p>}

      {isLoading && <Loader />}
      {isError && (
        <p className="text-muted-foreground">Could not load stuck issues.</p>
      )}
      {data && items.length === 0 && (
        <p className="text-muted-foreground">
          Nothing is stuck. Every open issue is moving.
        </p>
      )}
      {items.length > 0 && (
        <ul className="flex flex-col">
          {items.map((item) => (
            <StuckRow key={item.id} item={item} team={team} users={users} />
          ))}
        </ul>
      )}
    </Section>
  );
});

const DashboardView = observer(() => {
  const team = useCurrentTeam();
  const {
    data: metrics,
    isLoading,
    isError,
  } = useDashboardMetricsQuery(team?.id);

  return (
    <MainLayout header={<Header title="Dashboard" team={team} />} scrollable>
      <main className="p-4 flex flex-col gap-8 max-w-[960px] w-full mx-auto">
        {team && (
          <>
            {isLoading && <Loader />}
            {isError && (
              <p className="text-muted-foreground">
                Could not load the dashboard metrics.
              </p>
            )}
            {metrics && (
              <>
                <StatRow metrics={metrics} />
                <VelocityChart metrics={metrics} />
                <BurndownChart burndown={metrics.burndown} />
              </>
            )}
            <NeedsAttention team={team} />
          </>
        )}
      </main>
    </MainLayout>
  );
});

export const TeamDashboard = withApplicationStore(DashboardView);

TeamDashboard.getLayout = function getLayout(page: React.ReactElement) {
  return <AppLayout>{page}</AppLayout>;
};

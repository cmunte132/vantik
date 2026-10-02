import type {
  KnowledgeRunTrace,
  KnowledgeTraceRow,
  KnowledgeTracedRun,
} from '@vantikhq/types';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vantikhq/ui/components/select';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { AppLayout } from 'common/layouts/app-layout';
import { MainLayout } from 'common/layouts/main-layout';
import { useRouter } from 'common/router';

import { useKnowledgeRunTrace, useKnowledgeTracedRuns } from 'services/pages';

import { Header } from '../header';
import { age, CARD, Chip, type TrustTone } from '../trust';
import { GARDENER_ROUTE, TRACE_ROUTE } from './routes';

const TRUST_CHIP: Record<string, { tone?: TrustTone; label: string }> = {
  GROUNDED: { tone: 'code', label: 'Code confirms' },
  HUMAN_VERIFIED: { tone: 'people', label: 'Confirmed by a person' },
  OBSERVED: { tone: 'observed', label: 'Observed' },
  UNGROUNDED: { label: 'Unconfirmed' },
  PROVISIONAL: { label: 'Provisional' },
};

const DROPPED: Record<string, string> = {
  NOT_LIVE: 'not in use when the pack was built',
  NOT_TRUSTED: 'nothing checked supports it',
  TOP_K: 'ranked below the facts a pack gives',
  PROVISIONAL_LIMIT: 'provisional, and the pack held enough of those',
  BUDGET: 'cut by the token budget',
};

const PULL_REQUEST: Record<string, { tone?: TrustTone; label: string }> = {
  MERGED: { tone: 'code', label: 'Merged' },
  CLOSED: { tone: 'stale', label: 'Closed' },
};

/**
 * Why a run got the facts it got: what its pack asked for, what it found,
 * kept, ranked and gave, and what the run's outcome then said about each
 * fact.
 */
const TraceView = observer(() => {
  const router = useRouter();
  const { workspaceSlug, run, pack } = router.query as {
    workspaceSlug: string;
    run?: string;
    pack?: string;
  };
  const { data: runs } = useKnowledgeTracedRuns();
  const runId = run ?? runs?.[0]?.id;
  const { data: trace } = useKnowledgeRunTrace(runId, pack);

  const go = (query: Record<string, string | undefined>) =>
    router.replace(
      {
        pathname: TRACE_ROUTE,
        query: Object.fromEntries(
          Object.entries({ workspaceSlug, run: runId, ...query }).filter(
            ([, value]) => value,
          ),
        ),
      },
      undefined,
      { shallow: true },
    );

  return (
    <MainLayout
      scrollable
      header={
        <Header
          crumbs={[
            { label: 'Gardener', pathname: GARDENER_ROUTE },
            { label: 'Trace a run' },
          ]}
        />
      }
    >
      <div className="px-4 py-5 md:px-6 flex flex-col gap-4 max-w-[1200px]">
        {runs && runs.length === 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-xl font-semibold">
              Why a run got what it got
            </span>
            <span className="text-foreground/80">
              No run has been traced yet. The next agent run records the facts
              its pack considered, and why it gave each one.
            </span>
          </div>
        )}

        {trace && runs && (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex flex-col gap-1 grow min-w-[280px]">
                <span className="text-xl font-semibold">
                  Why this run got what it got
                </span>
                <span className="text-foreground/80">
                  Run {trace.run.id.slice(0, 6)} on{' '}
                  <span className="font-medium">
                    {[trace.run.issueKey, trace.run.issueTitle]
                      .filter(Boolean)
                      .join(' ')}
                  </span>
                  {trace.run.agentName ? ` · ${trace.run.agentName}` : ''} ·
                  started {age(trace.run.startedAt ?? trace.run.createdAt)} ago
                  ·{' '}
                  {trace.run.arm === 'HOLDOUT'
                    ? 'in the holdout: given no facts'
                    : 'given facts (not in the holdout)'}
                </span>
              </div>
              <RunPicker
                runs={runs}
                value={runId}
                onChange={(id) => go({ run: id, pack: undefined })}
              />
              {trace.packs.length > 1 && (
                <PackSwitch trace={trace} onChange={(id) => go({ pack: id })} />
              )}
            </div>

            {trace.trace ? (
              <>
                <Steps trace={trace} />
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
                  <FactTable trace={trace} />
                  <After trace={trace} />
                </div>
              </>
            ) : (
              <div className={cn(CARD, 'px-4 py-3.5 text-foreground/80')}>
                This run started before packs were traced, so there is no record
                of what its pack considered.
              </div>
            )}
          </>
        )}
      </div>
    </MainLayout>
  );
});

function RunPicker({
  runs,
  value,
  onChange,
}: {
  runs: KnowledgeTracedRun[];
  value?: string;
  onChange: (id: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-[260px] h-7" aria-label="Pick a run">
        <SelectValue placeholder="Pick a run" />
      </SelectTrigger>
      <SelectContent>
        {runs.map((run) => (
          <SelectItem key={run.id} value={run.id}>
            <span className="truncate">
              {run.issueKey ?? run.id.slice(0, 6)}
              {run.issueTitle ? ` ${run.issueTitle}` : ''}
            </span>
            <span className="text-muted-foreground">
              {' '}
              · {age(run.createdAt)} · {run.given} given
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The pack the run got at its start, and each one its agent loaded. */
function PackSwitch({
  trace,
  onChange,
}: {
  trace: KnowledgeRunTrace;
  onChange: (id: string) => void;
}) {
  let loads = 0;

  return (
    <div
      className="flex gap-0.5 p-0.5 bg-grayAlpha-100 rounded-lg"
      role="radiogroup"
      aria-label="Pick a pack"
    >
      {trace.packs.map((pack) => {
        const label =
          pack.via === 'CONTEXT_PACK' ? 'At start' : `load_context ${++loads}`;
        const active = pack.id === trace.trace?.id;

        return (
          <button
            key={pack.id}
            type="button"
            role="radio"
            aria-checked={active}
            title={pack.query}
            onClick={() => onChange(pack.id)}
            className={cn(
              'px-2.5 py-[3px] rounded-md text-xs whitespace-nowrap',
              active
                ? 'bg-background-3 font-medium shadow-[0_1px_2px_oklch(0%_0_0/0.08)]'
                : 'text-foreground/80',
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function Steps({ trace }: { trace: KnowledgeRunTrace }) {
  const pack = trace.trace as NonNullable<KnowledgeRunTrace['trace']>;
  const rows = pack.rows;
  const count = (test: (row: KnowledgeTraceRow) => boolean) =>
    rows.filter(test).length;
  const kept = rows.filter(
    (row) => row.dropped !== 'NOT_LIVE' && row.dropped !== 'NOT_TRUSTED',
  );
  const conventions = count((row) => row.source === 'CONVENTION' && row.given);
  const given = count((row) => row.given);
  const modules = (list: Array<{ name: string }>) =>
    list.map((module, index) => (
      <React.Fragment key={module.name}>
        {index > 0 && ', '}
        <span className="font-mono">{module.name}</span>
      </React.Fragment>
    ));

  return (
    <div className="grid gap-1.5 grid-cols-[repeat(auto-fit,minmax(170px,1fr))]">
      <Step n={1} title="Asked" figure={trace.run.issueKey ?? 'Its question'}>
        {pack.seedModules.length > 0 ? (
          <span>Modules: {modules(pack.seedModules)}</span>
        ) : (
          <span className="line-clamp-2" title={pack.query}>
            {pack.query}
          </span>
        )}
        {pack.neighbourModules.length > 0 && (
          <span>Neighbours: {modules(pack.neighbourModules)}</span>
        )}
      </Step>
      <Step n={2} title="Found" figure={`${rows.length} facts`}>
        <span>{count((row) => row.nearness === 'SEED')} in its modules</span>
        <span>
          {count((row) => row.nearness === 'NEIGHBOUR')} in neighbouring modules
        </span>
        <span>
          {count((row) => row.nearness === 'NONE')} matched the issue text
        </span>
        {pack.searchFailed && <span>The search failed: conventions only</span>}
      </Step>
      <Step n={3} title="Kept" figure={kept.length}>
        <span>
          {count((row) => row.dropped === 'NOT_TRUSTED')} dropped: nothing
          checked supports them
        </span>
        <span>
          {count((row) => row.dropped === 'NOT_LIVE')} not in use when it ran
        </span>
      </Step>
      <Step
        n={4}
        title="Ranked"
        figure={`${conventions} + ${kept.length - conventions}`}
      >
        <span>Its modules’ conventions first</span>
        <span>Then the order of the search</span>
      </Step>
      <Step n={5} title="Given" figure={`${given} facts`}>
        <span>
          {pack.tokensGiven.toLocaleString()} of{' '}
          {pack.tokenBudget.toLocaleString()} tokens
        </span>
        <span>
          {count((row) => row.dropped === 'BUDGET')} more cut by the budget
        </span>
        {count((row) => row.dropped === 'TOP_K') > 0 && (
          <span>{count((row) => row.dropped === 'TOP_K')} ranked too low</span>
        )}
      </Step>
    </div>
  );
}

function Step({
  n,
  title,
  figure,
  children,
}: {
  n: number;
  title: string;
  figure: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={cn(CARD, 'px-3.5 py-3 flex flex-col gap-1 min-w-0')}>
      <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        {n} · {title}
      </span>
      <span className="text-xl font-semibold truncate">{figure}</span>
      <div className="flex flex-col gap-0.5 text-xs leading-normal text-foreground/80">
        {children}
      </div>
    </div>
  );
}

const TABLE = 'grid grid-cols-[24px_minmax(0,1fr)_56px_100px] gap-3';

function FactTable({ trace }: { trace: KnowledgeRunTrace }) {
  const rows = [...(trace.trace?.rows ?? [])].sort(
    (a, b) =>
      (a.order ?? Number.MAX_SAFE_INTEGER) -
        (b.order ?? Number.MAX_SAFE_INTEGER) ||
      (a.searchRank ?? 0) - (b.searchRank ?? 0),
  );
  // Past the facts it gave, the ones cut nearest to making it.
  const shown = [
    ...rows.filter((row) => row.given),
    ...rows.filter((row) => !row.given).slice(0, 8),
  ];

  return (
    <div className={cn(CARD, 'flex flex-col overflow-hidden')}>
      <div
        className={cn(
          TABLE,
          'px-4 py-2.5 text-[11px] font-semibold tracking-wider text-muted-foreground',
        )}
      >
        <span>#</span>
        <span>FACT AND WHY IT WAS GIVEN</span>
        <span className="text-right">TOKENS</span>
        <span className="text-right">AFTER THE RUN</span>
      </div>
      {shown.map((row) => (
        <div
          key={row.entryId}
          className={cn(
            TABLE,
            'items-center px-4 py-[9px] border-t border-grayAlpha-100',
            !row.given && 'opacity-50',
          )}
        >
          <span className="text-xs font-semibold text-muted-foreground">
            {row.order ?? '–'}
          </span>
          <div className="flex flex-col gap-1 min-w-0">
            <span className="leading-snug">{row.content}</span>
            <div className="flex flex-wrap items-center gap-2">
              <FactChip row={row} />
              <span className="text-xs text-foreground/75">{why(row)}</span>
            </div>
          </div>
          <span className="font-mono text-xs text-right">
            {row.tokens ?? '–'}
          </span>
          <div className="flex justify-end">
            {row.given &&
              (row.after === 'well' ? (
                <Chip tone="code">Went well</Chip>
              ) : row.after === 'wrong' ? (
                <Chip tone="stale">Went wrong</Chip>
              ) : (
                <span className="text-xs text-muted-foreground">No signal</span>
              ))}
          </div>
        </div>
      ))}
      {rows.length === 0 && (
        <span className="px-4 py-3 border-t border-grayAlpha-100 text-foreground/75">
          The pack found no facts.
        </span>
      )}
    </div>
  );
}

function FactChip({ row }: { row: KnowledgeTraceRow }) {
  if (row.kind === 'CONVENTION') {
    return <Chip tone="people">Convention</Chip>;
  }

  const trust = TRUST_CHIP[row.trust ?? ''] ?? { label: 'Not read' };

  return <Chip tone={trust.tone}>{trust.label}</Chip>;
}

function why(row: KnowledgeTraceRow): string {
  if (row.source === 'CONVENTION' && row.given) {
    return row.where ? `always given in ${row.where}` : 'always given';
  }

  const near =
    row.nearness === 'SEED'
      ? 'its module'
      : row.nearness === 'NEIGHBOUR'
        ? 'a neighbouring module'
        : null;

  return [
    row.searchRank ? `search rank ${row.searchRank}` : null,
    near,
    row.dropped ? DROPPED[row.dropped] : null,
    !row.dropped && row.checkedAt ? `checked ${age(row.checkedAt)} ago` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function After({ trace }: { trace: KnowledgeRunTrace }) {
  const verdict = (passed: boolean | null) =>
    passed === null ? (
      <span className="text-xs text-muted-foreground">Not yet</span>
    ) : passed ? (
      <Chip tone="code">Passed</Chip>
    ) : (
      <Chip tone="stale">Failed</Chip>
    );
  const pullRequest = trace.after.pullRequest
    ? (PULL_REQUEST[trace.after.pullRequest] ?? {
        label: trace.after.pullRequest.toLowerCase(),
      })
    : null;

  return (
    <div className="flex flex-col gap-3">
      <div className={cn(CARD, 'px-4 py-3.5 flex flex-col gap-2')}>
        <span className="text-[15px] font-semibold">After the run</span>
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-2">
            <span className="grow">Checks</span>
            {verdict(trace.after.checks)}
          </div>
          <div className="flex gap-2">
            <span className="grow">Review</span>
            {verdict(trace.after.review)}
          </div>
          <div className="flex gap-2">
            <span className="grow">Pull request</span>
            {pullRequest ? (
              <Chip tone={pullRequest.tone}>{pullRequest.label}</Chip>
            ) : (
              <span className="text-xs text-muted-foreground">None yet</span>
            )}
          </div>
        </div>
      </div>

      {trace.rechecks.map((recheck) => (
        <div
          key={recheck.entryId}
          className="rounded-[10px] px-4 py-3.5 flex flex-col gap-2 bg-[oklch(61.34%_0.162_23.58/0.13)] border border-[oklch(61.34%_0.162_23.58/0.3)]"
        >
          <span className="font-semibold">
            {recheck.order ? `Fact ${recheck.order}` : 'A fact it got'} is being
            re-checked
          </span>
          <span className="text-xs leading-normal">
            {recheck.evidence ?? 'The run went wrong with it.'} The gardener
            reads its citations again. If the code no longer supports it, it
            goes to Needs you.
          </span>
        </div>
      ))}

      <div className={cn(CARD, 'px-4 py-3.5 flex flex-col gap-1.5')}>
        <span className="text-xs font-semibold text-foreground/75">
          Model calls this run caused
        </span>
        {trace.modelCalls.length === 0 && (
          <span className="text-xs text-foreground/75">None yet.</span>
        )}
        {trace.modelCalls.map((call) => (
          <span key={call.purpose} className="text-xs">
            <span className="font-mono">{call.purpose}</span> · {call.count}{' '}
            call{call.count === 1 ? '' : 's'} · {call.detail}
          </span>
        ))}
      </div>
    </div>
  );
}

export function KnowledgeTracePage() {
  return <TraceView />;
}

KnowledgeTracePage.getLayout = function getLayout(page: React.ReactElement) {
  return <AppLayout>{page}</AppLayout>;
};

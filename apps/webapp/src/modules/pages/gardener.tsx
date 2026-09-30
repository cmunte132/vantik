import type {
  KnowledgeFactFlow,
  KnowledgeGardenerEvent,
  KnowledgeGardenerJob,
  KnowledgeGardenerStat,
} from '@vantikhq/types';

import { RiShareLine } from '@remixicon/react';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import * as React from 'react';

import { AppLayout } from 'common/layouts/app-layout';
import { MainLayout } from 'common/layouts/main-layout';
import { Link, useRouter } from 'common/router';

import { useKnowledgeGardener } from 'services/pages';

import { GARDENER_ROUTE, MAP_ROUTE, TRACE_ROUTE } from './garden/routes';
import { Header } from './header';
import { age, CARD, Chip } from './trust';

/** The colours the gardener's figures, log and flow use. */
export const GARDEN_COLOR = {
  code: 'oklch(64.93% 0.107 154)',
  people: 'oklch(60% 0.13 240)',
  observed: 'oklch(72% 0.11 100)',
  needYou: 'oklch(66% 0.18 45)',
  replaced: 'oklch(55% 0.15 300)',
  refines: 'oklch(58% 0.1 200)',
  retired: 'oklch(61.34% 0.162 23.58)',
  grey: 'oklch(62% 0 0)',
  quiet: 'oklch(70% 0 0)',
};

const STAT_TONE: Record<KnowledgeGardenerStat['tone'], string> = {
  good: 'text-[oklch(42%_0.1_154)] dark:text-[oklch(75%_0.1_154)]',
  people: 'text-[oklch(45%_0.13_240)] dark:text-[oklch(75%_0.1_240)]',
  plain: 'text-foreground',
  warn: 'text-[oklch(55%_0.19_45)] dark:text-[oklch(75%_0.15_45)]',
};

const EVENT_COLOR: Record<KnowledgeGardenerEvent['kind'], string> = {
  contradicted: GARDEN_COLOR.needYou,
  escalated: GARDEN_COLOR.needYou,
  'proposed-archive': GARDEN_COLOR.needYou,
  replaced: GARDEN_COLOR.replaced,
  convention: GARDEN_COLOR.people,
  backoff: GARDEN_COLOR.retired,
  resumed: GARDEN_COLOR.code,
  archived: GARDEN_COLOR.grey,
};

/** Each job as a person knows it, and when it runs. */
const JOBS: Record<string, { title: string; when: string }> = {
  triageEntry: { title: 'Triage', when: 'Every new fact' },
  recheckLandedChange: {
    title: 'Check facts when code lands',
    when: 'Every push to a default branch',
  },
  recordRunFindings: {
    title: 'Conventions from review',
    when: 'After each agent run',
  },
  openKnowledgeGapIssues: { title: 'Gap issues', when: 'Mondays 04:00' },
  runDecay: { title: 'Decay', when: 'Nightly 03:00' },
  refreshGeneratedPages: { title: 'Refresh generated pages', when: 'Hourly' },
  verifyEntry: {
    title: 'Verifier agent',
    when: 'An uncited fact, before a person sees it',
  },
  recheckEntryCitations: {
    title: 'Re-check after a run went wrong',
    when: 'A run that went wrong with a fact',
  },
  retryUnknownCitations: {
    title: 'Read citations again',
    when: 'A citation that could not be read',
  },
};

/**
 * What the gardener does: how much it settles alone, how far people agree
 * with it, where the facts it saw went, what it did, and its jobs.
 */
const GardenerView = observer(() => {
  const {
    query: { workspaceSlug },
  } = useRouter();
  const { data } = useKnowledgeGardener();

  return (
    <MainLayout scrollable header={<Header crumbs={[{ label: 'Gardener' }]} />}>
      <div className="px-4 py-5 md:px-6 flex flex-col gap-[18px] max-w-[1200px]">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-col gap-1 grow min-w-[240px]">
            <span className="text-xl font-semibold">The gardener</span>
            <span className="text-foreground/80">
              Background jobs that check, settle and prune what agents write.
              Everything it does is logged and can be undone.
            </span>
          </div>
          {data && (
            <Chip tone={data.autoTriage === 'on' ? 'code' : undefined}>
              Triage: {data.autoTriage}
            </Chip>
          )}
          <Link
            href={{ pathname: TRACE_ROUTE, query: { workspaceSlug } }}
            className="font-medium text-primary whitespace-nowrap"
          >
            Trace a run →
          </Link>
          <Link
            href={{ pathname: MAP_ROUTE, query: { workspaceSlug } }}
            className="flex items-center gap-1.5 h-7 px-3 rounded-lg bg-background-3 shadow-[0_0_0_1px_oklch(0%_0_0/0.1)] font-medium"
          >
            <RiShareLine size={14} />
            Map
          </Link>
        </div>

        {data && (
          <>
            <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(200px,1fr))]">
              <Stat
                label="Settled without a person, this week"
                stat={data.settled}
              />
              <Stat label="Agreement with people" stat={data.agreement} />
              <Stat
                label="Runs that pass checks, with facts vs without"
                stat={data.withKnowledge}
              />
              <Stat
                label="Facts checked against the code this week"
                stat={data.citations}
              />
            </div>

            <div className="grid gap-[18px] lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="flex flex-col gap-4 min-w-0">
                <div
                  className={cn(CARD, 'px-[18px] py-4 flex flex-col gap-2.5')}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="text-[15px] font-semibold grow">
                      The life of a fact
                    </span>
                    <span className="text-xs text-muted-foreground">
                      last {data.flow.windowDays} days
                    </span>
                  </div>
                  {data.flow.written ? (
                    <FactFlow flow={data.flow} />
                  ) : (
                    <span className="text-foreground/75">
                      No agent wrote a fact in the last {data.flow.windowDays}{' '}
                      days.
                    </span>
                  )}
                </div>

                <div
                  className={cn(CARD, 'px-[18px] pt-3.5 pb-1 flex flex-col')}
                >
                  <span className="text-[15px] font-semibold pb-1.5">
                    What it did
                  </span>
                  {data.events.length === 0 && (
                    <span className="py-2.5 border-t border-grayAlpha-100 text-foreground/75">
                      Nothing in the last {data.flow.windowDays} days.
                    </span>
                  )}
                  {data.events.map((event) => (
                    <EventRow key={event.id} event={event} />
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-2 min-w-0">
                <span className="text-[15px] font-semibold px-0.5">
                  Its jobs
                </span>
                {data.jobs.map((job) => (
                  <JobRow key={job.job} job={job} />
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </MainLayout>
  );
});

function Stat({ label, stat }: { label: string; stat: KnowledgeGardenerStat }) {
  return (
    <div className={cn(CARD, 'px-4 py-3.5 flex flex-col gap-1 min-w-0')}>
      <span className="text-xs font-medium text-foreground/75">{label}</span>
      <span
        className={cn(
          'text-2xl font-semibold',
          stat.value ? STAT_TONE[stat.tone] : 'text-muted-foreground',
        )}
      >
        {stat.value ?? '–'}
      </span>
      <span className="text-xs leading-snug text-foreground/75">
        {stat.note}
      </span>
    </div>
  );
}

const EventRow = observer(({ event }: { event: KnowledgeGardenerEvent }) => {
  const {
    query: { workspaceSlug },
  } = useRouter();
  // An escalation waits in Needs you under its fact; a proposal to retire
  // one, under the proposal.
  const subject = event.kind === 'proposed-archive' ? event.id : event.entryId;

  return (
    <div className="flex gap-3 items-start py-2.5 border-t border-grayAlpha-100">
      <span className="text-xs text-muted-foreground w-[34px] shrink-0 pt-px">
        {age(event.at)}
      </span>
      <span
        className="size-2 rounded-full mt-[5px] shrink-0"
        style={{ background: EVENT_COLOR[event.kind] }}
      />
      <div className="flex flex-col gap-0.5 grow min-w-0">
        <span className="font-medium leading-snug">{event.title}</span>
        <span className="text-xs leading-snug text-foreground/75">
          {event.detail}
        </span>
      </div>
      {event.inboxItemId && subject && (
        <Link
          href={{
            pathname: '/[workspaceSlug]/pages/needs-you',
            query: { workspaceSlug, subject },
          }}
          className="text-xs text-primary whitespace-nowrap"
        >
          Open
        </Link>
      )}
    </div>
  );
});

function JobRow({ job }: { job: KnowledgeGardenerJob }) {
  const known = JOBS[job.job] ?? { title: job.job, when: '' };
  const failing = job.failedThisWeek > 0;
  const dot = !job.lastRunAt
    ? GARDEN_COLOR.quiet
    : failing
      ? GARDEN_COLOR.retired
      : GARDEN_COLOR.code;

  return (
    <div
      className={cn(CARD, 'flex gap-2.5 items-start px-3 py-2.5 rounded-[9px]')}
    >
      <span
        className="size-2 rounded-full mt-[5px] shrink-0"
        style={{ background: dot }}
      />
      <div className="flex flex-col gap-0.5 grow min-w-0">
        <div className="flex gap-2 items-baseline">
          <span className="font-semibold grow">{known.title}</span>
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {job.lastRunAt ? age(job.lastRunAt) : 'Not run yet'}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">{known.when}</span>
        {job.outcome && (
          <span className="text-xs leading-snug text-foreground/85">
            {job.outcome}
          </span>
        )}
        {failing && (
          <span
            className="text-xs leading-snug text-[oklch(48%_0.16_25)] dark:text-[oklch(78%_0.12_25)] truncate"
            title={job.lastError ?? undefined}
          >
            {job.failedThisWeek} of {job.runsThisWeek} runs failed this week
            {job.lastError ? `: ${job.lastError}` : ''}
          </span>
        )}
      </div>
    </div>
  );
}

const FLOW_WIDTH = 640;
const FLOW_HEIGHT = 290;
const BAR = 14;
const MID_X = 220;
const END_X = 440;
const COLUMN = 240;
const GAP = 8;

interface Band {
  key: string;
  count: number;
  label: string;
  note?: string;
  color: string;
  /** Whether its facts are in use now, and so flow on to the right. */
  inUse?: boolean;
}

/**
 * Where the facts written in the window went, as a flow from left to right:
 * all written, then how each was decided, then those in use now.
 */
export function FactFlow({ flow }: { flow: KnowledgeFactFlow }) {
  const bands: Band[] = [
    {
      key: 'refused',
      count: flow.refused,
      label: 'Refused',
      color: GARDEN_COLOR.retired,
    },
    {
      key: 'folded',
      count: flow.folded,
      label: 'Folded into a repeat',
      note: 'counted as corroboration',
      color: GARDEN_COLOR.grey,
    },
    {
      key: 'settled',
      count: flow.settledByAgents,
      label: 'Settled by agents',
      note: 'code or evidence confirmed',
      color: GARDEN_COLOR.code,
      inUse: true,
    },
    {
      key: 'people',
      count: flow.decidedByPeople,
      label: 'Decided by people',
      note: 'in Needs you',
      color: GARDEN_COLOR.people,
      inUse: true,
    },
    {
      key: 'waiting',
      count: flow.waiting,
      label: 'Waiting',
      color: GARDEN_COLOR.needYou,
    },
  ].filter((band) => band.count > 0);

  const scale = COLUMN / Math.max(flow.written, 1);
  const height = (count: number) => Math.max(count * scale, 2);
  const top = 20;

  // Each band's place on the left bar and in the middle column.
  let left = top;
  let middle = 4;
  const placed = bands.map((band) => {
    const h = height(band.count);
    const at = { band, h, left, middle };
    left += h;
    middle += h + GAP;
    return at;
  });

  const flowing = placed.filter((at) => at.band.inUse);
  const endHeight = flowing.reduce((sum, at) => sum + at.h, 0);
  const endTop = flowing[0] ? flowing[0].middle + 4 : 90;
  let end = endTop;

  // Labels sit beside their band, pushed down so that none overlap.
  let floor = 0;
  const labels = placed.map((at) => {
    const y = Math.max(at.middle + at.h / 2 + 4, floor + 14);
    floor = y + (at.band.note ? 14 : 0);
    return { ...at, y };
  });

  const retiredWhy = [
    flow.retiredContradicted &&
      `${flow.retiredContradicted} contradicted by code`,
    flow.retiredUnused && `${flow.retiredUnused} unused 90 days`,
    flow.retiredReplaced && `${flow.retiredReplaced} replaced`,
    flow.retiredOther && `${flow.retiredOther} by a person`,
  ].filter(Boolean) as string[];

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${FLOW_WIDTH} ${FLOW_HEIGHT}`}
      className="block"
      role="img"
      aria-label={`${flow.written} facts written; ${flow.inUse} in use now`}
    >
      {placed.map((at) => (
        <path
          key={`in-${at.band.key}`}
          d={stream(BAR, at.left, MID_X, at.middle, at.h)}
          fill={at.band.color}
          fillOpacity={0.22}
        />
      ))}
      {flowing.map((at) => {
        const d = stream(MID_X + BAR, at.middle, END_X, end, at.h);
        end += at.h;
        return (
          <path
            key={`out-${at.band.key}`}
            d={d}
            fill={at.band.color}
            fillOpacity={0.22}
          />
        );
      })}

      <rect
        x={0}
        y={top}
        width={BAR}
        height={left - top}
        rx={2}
        className="fill-foreground/80"
      />
      {placed.map((at) => (
        <rect
          key={`bar-${at.band.key}`}
          x={MID_X}
          y={at.middle}
          width={BAR}
          height={at.h}
          rx={2}
          fill={at.band.color}
        />
      ))}
      {endHeight > 0 && (
        <rect
          x={END_X}
          y={endTop}
          width={BAR}
          height={endHeight}
          rx={2}
          className="fill-foreground/80"
        />
      )}

      <text
        x={22}
        y={14}
        fontSize={12}
        fontWeight={600}
        className="fill-foreground"
      >
        Written {flow.written}
      </text>
      {labels.map((at) => (
        <React.Fragment key={`label-${at.band.key}`}>
          <Halo x={MID_X + 22} y={at.y} bold>
            {at.band.label} {at.band.count}
          </Halo>
          {at.band.note && (
            <Halo x={MID_X + 22} y={at.y + 14} small>
              {at.band.note}
            </Halo>
          )}
        </React.Fragment>
      ))}

      <g transform={`translate(${END_X + 22} ${Math.max(endTop + 14, 104)})`}>
        <text y={0} fontSize={12} fontWeight={600} className="fill-foreground">
          In use {flow.inUse}
        </text>
        <text y={22} fontSize={12} className="fill-foreground/85">
          Given to runs {flow.givenTimes} times
        </text>
        <text y={40} fontSize={12} fill="oklch(52% 0.1 154)">
          {flow.runsWell} runs went well with them
        </text>
        <text y={58} fontSize={12} fill="oklch(55% 0.16 25)">
          {flow.runsWrong} runs went wrong with them
        </text>
        {flow.runsWrong > 0 && (
          <text y={76} fontSize={12} className="fill-muted-foreground">
            each one re-checked
          </text>
        )}
        <text
          y={132}
          fontSize={12}
          fontWeight={600}
          className="fill-foreground"
        >
          Retired {flow.retired}
        </text>
        {retiredWhy.map((line, index) => (
          <text
            key={line}
            y={150 + index * 16}
            fontSize={12}
            className="fill-muted-foreground"
          >
            {line}
          </text>
        ))}
      </g>
    </svg>
  );
}

/** A band of flow from one bar to the next, as a filled curve. */
function stream(x1: number, y1: number, x2: number, y2: number, h: number) {
  const mid = (x1 + x2) / 2;

  return [
    `M${x1} ${y1}`,
    `C${mid} ${y1},${mid} ${y2},${x2} ${y2}`,
    `L${x2} ${y2 + h}`,
    `C${mid} ${y2 + h},${mid} ${y1 + h},${x1} ${y1 + h}`,
    'Z',
  ].join(' ');
}

/** A label drawn over the flow, with a halo of the card behind it. */
function Halo({
  x,
  y,
  bold,
  small,
  children,
}: {
  x: number;
  y: number;
  bold?: boolean;
  small?: boolean;
  children: React.ReactNode;
}) {
  return (
    <text
      x={x}
      y={y}
      fontSize={small ? 11 : 12}
      fontWeight={bold ? 600 : 400}
      strokeWidth={3}
      paintOrder="stroke"
      className={cn(
        'stroke-background-3',
        small ? 'fill-muted-foreground' : 'fill-foreground',
      )}
    >
      {children}
    </text>
  );
}

export function Gardener() {
  return <GardenerView />;
}

Gardener.getLayout = function getLayout(page: React.ReactElement) {
  return <AppLayout>{page}</AppLayout>;
};

export { GARDENER_ROUTE };

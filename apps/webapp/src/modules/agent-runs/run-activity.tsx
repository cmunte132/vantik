import {
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiCheckLine,
  RiCloseLine,
  RiEditLine,
  RiFileTextLine,
  RiLoader4Line,
  RiSearchLine,
  RiTerminalBoxLine,
  RiTerminalLine,
} from '@remixicon/react';
import { getInitials } from '@vantikhq/ui/components/avatar';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import React from 'react';
import ReactTimeAgo from 'react-time-ago';

import { AgentQuestionCard } from 'modules/agent-questions/agent-question-card';

import { useContextStore } from 'store/global-context-provider';

import {
  FILTERS,
  type FeedItem,
  type Filter,
  type Step,
  basename,
  clock,
  diffLines,
  matches,
  phrase,
} from './run-feed';

interface Props {
  feed: FeedItem[];
  /** When the run's clock started, in ms, for the time column. */
  start: number;
  /** The row still in flight on a live run, if any. */
  current: FeedItem | null;
  agentName?: string;
  /**
   * The harness that did the work, when it is the person's own (omp on their
   * machine). Its replies carry its name rather than the agent's initials, so
   * nobody mistakes them for a hosted agent's.
   */
  harness?: string;
  live: boolean;
  setupMs?: number;
  /**
   * What the person did in their own terminal, for the heading of that
   * segment: the turns it took and when it was last active.
   */
  terminal?: { turns: number; lastActiveAt?: string | null };
}

/**
 * What the agent did, as one feed.
 *
 * Its narration, its steps and what they changed read top to bottom on one
 * rail, each row stamped with the run's own clock. A failure opens itself and
 * shows its output, because that is why anyone opens this page after a bad
 * run. The filters narrow the feed to one kind of row; setting up and the
 * cycle's own milestones show only under All.
 */
export const RunActivity = observer(
  ({
    feed,
    start,
    current,
    agentName,
    harness,
    live,
    setupMs,
    terminal,
  }: Props) => {
    const [filter, setFilter] = React.useState<Filter>('All');
    const shown = feed.filter((item) => matches(item, filter));
    const initials = getInitials(agentName ?? 'Agent');

    // The time column counts from the run's start, and from the heading of a
    // terminal segment inside that segment: hours later it would only show a
    // big number.
    const clockStart = new Map<string, number>();
    let base = start;
    for (const item of feed) {
      if (item.type === 'terminal' && item.at) {
        base = Date.parse(item.at);
      }
      clockStart.set(item.id, base);
    }

    return (
      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="grow text-[14px] font-semibold">Activity</h2>

          {FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setFilter(option)}
              aria-pressed={filter === option}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-sm',
                filter === option
                  ? 'border-transparent bg-grayAlpha-100'
                  : 'border-border hover:bg-grayAlpha-50',
              )}
            >
              {option}
            </button>
          ))}
        </div>

        {shown.length === 0 ? (
          <p className="py-4 text-muted-foreground">
            {feed.length === 0
              ? live
                ? 'Waiting for the runner to report something.'
                : 'This run recorded no progress events.'
              : 'Nothing of this kind yet.'}
          </p>
        ) : (
          <ol className="flex flex-col">
            {shown.map((item, index) => (
              <Row
                key={item.id}
                item={item}
                at={
                  item.at && item.type !== 'terminal'
                    ? clock(
                        Date.parse(item.at) -
                          (clockStart.get(item.id) ?? start),
                      )
                    : ''
                }
                running={item === current}
                last={index === shown.length - 1}
                initials={initials}
                harness={harness}
                setupMs={setupMs}
                terminal={terminal}
              />
            ))}
          </ol>
        )}
      </section>
    );
  },
);

const Row = ({
  item,
  at,
  running,
  last,
  initials,
  harness,
  setupMs,
  terminal,
}: {
  item: FeedItem;
  at: string;
  running: boolean;
  last: boolean;
  initials: string;
  harness?: string;
  setupMs?: number;
  terminal?: Props['terminal'];
}) => {
  return (
    <li className="grid grid-cols-[46px_24px_minmax(0,1fr)] gap-x-2.5">
      <span className="pt-2.5 text-right font-mono text-xs text-muted-foreground">
        {at}
      </span>

      <span className="relative flex justify-center">
        {!last && (
          <span className="absolute top-0 bottom-0 left-1/2 w-px -translate-x-1/2 bg-border" />
        )}
        {last && (
          <span className="absolute top-0 left-1/2 h-2 w-px -translate-x-1/2 bg-border" />
        )}
        <Node
          item={item}
          running={running}
          initials={initials}
          harness={harness}
        />
      </span>

      <div className="flex min-w-0 flex-col gap-1.5 pt-2 pb-2.5">
        {item.type === 'setup' ? (
          <Title
            title={
              running ? 'Setting up the environment' : 'Set up the environment'
            }
            meta={[
              ...item.lines.map(lowerFirst),
              ...(setupMs && !running ? [clock(setupMs)] : []),
            ].join(' · ')}
            failed={item.failed}
            running={running}
          />
        ) : item.type === 'terminal' ? (
          <TerminalHeading terminal={terminal} />
        ) : (
          <StepBody step={item.step} running={running} />
        )}
      </div>
    </li>
  );
};

const Node = ({
  item,
  running,
  initials,
  harness,
}: {
  item: FeedItem;
  running: boolean;
  initials: string;
  harness?: string;
}) => {
  const step = item.type === 'step' ? item.step : null;
  const failed = item.type === 'setup' ? item.failed : Boolean(step?.failed);
  const base =
    'relative mt-2 grid size-[22px] place-items-center rounded-full border';

  if (item.type === 'terminal') {
    return (
      <span
        className={cn(base, 'border-border bg-background-3 text-foreground')}
      >
        <RiTerminalBoxLine size={13} />
      </span>
    );
  }

  // What the person typed, as opposed to what the agent answered.
  if (step?.role === 'user') {
    return (
      <span
        className={cn(
          base,
          'border-border bg-background-3 text-[8.5px] font-semibold',
        )}
      >
        You
      </span>
    );
  }

  if (step?.kind === 'note' && harness) {
    return (
      <span
        className={cn(
          base,
          'border-border bg-background-3 text-[8.5px] font-semibold',
        )}
      >
        {harness}
      </span>
    );
  }

  if (step?.kind === 'note') {
    return (
      <span
        className={cn(
          base,
          'border-primary bg-primary text-[8.5px] font-semibold text-white',
        )}
      >
        {initials}
      </span>
    );
  }

  if (failed) {
    return (
      <span
        className={cn(base, 'border-destructive bg-destructive text-white')}
      >
        <RiCloseLine size={13} />
      </span>
    );
  }

  if (running) {
    return (
      <span
        className={cn(base, 'border-primary/50 bg-background-3 text-primary')}
      >
        <RiLoader4Line size={13} className="animate-spin" />
      </span>
    );
  }

  const passed =
    item.type === 'setup' ||
    (step?.kind === 'test' && step.ended && !step.failed);

  if (passed) {
    return (
      <span className={cn(base, 'border-success bg-success text-white')}>
        <RiCheckLine size={13} />
      </span>
    );
  }

  return (
    <span
      className={cn(
        base,
        'border-border bg-background-3 text-muted-foreground',
      )}
    >
      <StepIcon kind={step?.kind} />
    </span>
  );
};

/** The heading of the work a person did in their own terminal. */
const TerminalHeading = ({ terminal }: { terminal: Props['terminal'] }) => (
  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
    <span className="font-medium">Continued in your terminal</span>
    {terminal && (
      <span className="text-muted-foreground">
        {terminal.turns} {terminal.turns === 1 ? 'turn' : 'turns'}
        {terminal.lastActiveAt && (
          <>
            {' '}
            · last active{' '}
            <ReactTimeAgo date={new Date(terminal.lastActiveAt)} />
          </>
        )}
      </span>
    )}
  </div>
);

const StepIcon = ({ kind }: { kind?: string }) => {
  switch (kind) {
    case 'read':
      return <RiFileTextLine size={12} />;
    case 'write':
      return <RiEditLine size={12} />;
    case 'search':
      return <RiSearchLine size={12} />;
    case 'bash':
    case 'test':
      return <RiTerminalLine size={12} />;
    default:
      // No kind, or one this bundle has never heard of: an older run, a
      // newer harness, or one of the cycle's own milestones. The row still
      // shows its message.
      return <span className="size-1.5 rounded-full bg-current" />;
  }
};

const Title = ({
  title,
  meta,
  failed,
  running,
  mono,
}: {
  title: string;
  meta?: string;
  failed?: boolean;
  running?: boolean;
  mono?: boolean;
}) => (
  <div className="flex min-w-0 items-baseline gap-2">
    {/* Rigid only beside a meta column, which truncates instead. A line
        that is all title (a cleanup, an error) can be a sentence and wraps. */}
    <span
      className={cn(
        'font-medium',
        meta ? 'shrink-0' : 'min-w-0',
        failed && 'text-destructive',
        running && 'text-primary',
      )}
    >
      {title}
    </span>
    {meta && (
      <span
        className={cn(
          'min-w-0 truncate text-muted-foreground',
          mono && 'font-mono text-sm',
        )}
        title={meta}
      >
        {meta}
      </span>
    )}
  </div>
);

/**
 * A question to a person. While it is open the run view pins its form above
 * the feed, so the row only says it was asked. Once it has an answer, or has
 * expired, the card shows here, at the point in the work where it happened.
 */
const QuestionBody = observer(({ step }: { step: Step }) => {
  const { agentQuestionsStore } = useContextStore();
  const question = agentQuestionsStore.getQuestionById(step.agentQuestionId);

  if (!question || question.status === 'OPEN') {
    return <Title title={step.message} />;
  }

  return (
    <AgentQuestionCard questionId={question.id} hideIssue className="my-0.5" />
  );
});

const StepBody = ({ step, running }: { step: Step; running: boolean }) => {
  if (step.kind === 'note') {
    return <Note text={step.text ?? step.message} />;
  }

  if (step.kind === 'question' && step.agentQuestionId) {
    return <QuestionBody step={step} />;
  }

  const many = step.count > 1;

  return (
    <>
      <Title
        title={phrase(step)}
        meta={metaOf(step, many)}
        failed={step.failed}
        running={running}
        mono={step.kind === 'bash' || step.kind === 'test'}
      />

      {many && (
        <div className="flex flex-wrap gap-1.5">
          {step.targets.map((target, index) => (
            <span
              key={`${target}-${index}`}
              title={target}
              className="rounded-md bg-grayAlpha-100 px-2 py-0.5 font-mono text-sm"
            >
              {step.kind === 'read' ? basename(target) : target}
            </span>
          ))}
        </div>
      )}

      {step.diff && <Diff step={step} />}

      {step.output && (
        <pre className="max-h-64 overflow-auto rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-sm leading-relaxed whitespace-pre-wrap">
          {step.output}
        </pre>
      )}
    </>
  );
};

/**
 * What the agent said, as prose.
 *
 * A long message is cut to its start until somebody asks: the closing report
 * is several paragraphs, and it is already in the outcome card.
 */
const Note = ({ text }: { text: string }) => {
  const long = text.length > 320 || text.split('\n').length > 4;
  const [open, setOpen] = React.useState(false);

  return (
    <div className="flex flex-col items-start gap-1">
      <p
        className={cn(
          'text-[14px] leading-normal whitespace-pre-wrap',
          long && !open && 'line-clamp-4',
        )}
      >
        {text}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          {open ? (
            <RiArrowDownSLine size={14} />
          ) : (
            <RiArrowRightSLine size={14} />
          )}
          {open ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  );
};

const Diff = ({ step }: { step: Step }) => (
  <div className="overflow-hidden rounded-lg border border-border bg-background-3">
    <div className="flex items-center gap-2.5 border-b border-border px-3 py-1.5 font-mono text-sm">
      <span className="grow truncate text-muted-foreground">
        {step.targets[0]}
      </span>
      <Counts added={step.added} removed={step.removed} />
    </div>
    <div className="overflow-x-auto py-1 font-mono text-sm leading-relaxed">
      {diffLines(step.diff ?? '').map((line, index) => (
        <div
          key={index}
          className={cn(
            'flex gap-2.5 px-3 whitespace-pre',
            line.mark === '+' && 'bg-success/15',
            line.mark === '-' && 'bg-destructive/10',
          )}
        >
          <span
            className={cn(
              'w-2.5 shrink-0 select-none',
              line.mark === '+' ? 'text-success' : 'text-destructive',
            )}
          >
            {line.mark === '-' ? '−' : line.mark.trim()}
          </span>
          <span>{line.text}</span>
        </div>
      ))}
    </div>
  </div>
);

/** `+18 −4`, in the diff colours. Nothing for a count nobody reported. */
export const Counts = ({
  added,
  removed,
}: {
  added?: number;
  removed?: number;
}) => (
  <span className="shrink-0 font-mono text-sm">
    {added != null && <span className="text-success">+{added}</span>}
    {added != null && removed != null && ' '}
    {removed != null && <span className="text-destructive">−{removed}</span>}
  </span>
);

/** The detail line beside a step's name. */
function metaOf(step: Step, many: boolean): string | undefined {
  switch (step.kind) {
    case 'bash':
    case 'test': {
      const counts = [
        step.failedCount != null ? `${step.failedCount} failed` : '',
        step.passed != null ? `${step.passed} passed` : '',
        step.exit != null && step.failed ? `exit ${step.exit}` : '',
      ].filter(Boolean);

      return [...counts, step.command ?? ''].filter(Boolean).join(' · ');
    }
    case 'write':
      // The diff card carries the counts when there is one.
      if (step.diff) {
        return undefined;
      }
      return [
        step.added != null ? `+${step.added}` : '',
        step.removed != null ? `−${step.removed}` : '',
      ]
        .filter(Boolean)
        .join(' ');
    case 'read':
      // The name says which file; the path says where it is.
      return many ? undefined : step.targets[0];
    default:
      return undefined;
  }
}

function lowerFirst(text: string): string {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}

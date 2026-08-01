/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiCheckLine,
  RiCloseLine,
  RiCodeSSlashLine,
  RiEditLine,
  RiFileTextLine,
  RiSearchLine,
} from '@remixicon/react';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import React from 'react';

import { PHASE_LABEL, PHASE_ORDER, formatMs, isLive } from './run-vocabulary';

interface Props {
  run: any;
  events: any[];
}

/**
 * What the agent did, as one continuous rail.
 *
 * A run is one thing that progressed, so it is drawn as one line with nodes on
 * it. Four bordered accordions — which is what this was — draw four unrelated
 * things and rank none of them.
 *
 * Three rules do most of the work. Adjacent steps of the same kind merge into
 * one row with a count, because twenty file reads are worth one line of
 * vertical space and not twenty. A step that failed opens itself and shows its
 * output, because that is the whole reason anyone opens this page after a bad
 * run. Everything else is a heading until somebody asks.
 *
 * A live run and a finished one render identically — the last node pulses and
 * new steps append. Nothing reflows when the run ends.
 */
export const RunTimeline = observer(({ run, events }: Props) => {
  const phases = groupByPhase(events);
  const live = isLive(run.status);
  const timings = (run.phaseTimings ?? {}) as Record<string, number>;

  if (phases.length === 0) {
    return (
      <p className="text-muted-foreground">
        {live
          ? 'Waiting for the runner to report something.'
          : 'This run recorded no progress events.'}
      </p>
    );
  }

  return (
    <div className="flex flex-col">
      {phases.map(({ phase, lines }, index) => (
        <PhaseNode
          key={phase}
          phase={phase}
          steps={toSteps(lines)}
          durationMs={timings[phase]}
          running={live && index === phases.length - 1}
          last={index === phases.length - 1}
        />
      ))}
    </div>
  );
});

const PhaseNode = observer(
  ({
    phase,
    steps,
    durationMs,
    running,
    last,
  }: {
    phase: string;
    steps: Step[];
    durationMs?: number;
    running: boolean;
    last: boolean;
  }) => {
    const broke = steps.some((step) => step.failed);

    return (
      <div className="flex flex-col">
        <div className="flex items-center gap-2.5 py-2">
          <Node
            state={running ? 'now' : broke ? 'fail' : 'done'}
            line={!last}
          />

          <span className="grow truncate font-medium">
            {PHASE_LABEL[phase] ?? phase}
          </span>

          {durationMs ? (
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {formatMs(durationMs)}
            </span>
          ) : null}
        </div>

        {steps.length > 0 && (
          <div className="flex">
            {/* The rail continues past the steps, so the phases read as one
                line rather than as a stack of blocks. */}
            <div className="relative w-5 shrink-0">
              {!last && (
                <span className="absolute inset-y-0 left-1/2 -ml-px w-px bg-border" />
              )}
            </div>

            <div className="flex min-w-0 grow flex-col pb-2">
              {steps.map((step) => (
                <StepRow key={step.id} step={step} />
              ))}
            </div>
          </div>
        )}
      </div>
    );
  },
);

const Node = ({
  state,
  line,
}: {
  state: 'done' | 'fail' | 'now';
  line: boolean;
}) => (
  <span className="relative grid w-5 shrink-0 place-items-center self-stretch">
    {line && (
      <span className="absolute inset-y-0 left-1/2 -ml-px w-px bg-border" />
    )}

    <span
      className={cn(
        'z-10 grid size-[18px] place-items-center rounded-full border bg-background',
        state === 'done' && 'border-green-500/45 text-green-600',
        state === 'fail' && 'border-destructive/50 text-destructive',
        state === 'now' && 'animate-pulse border-primary/55 text-primary',
      )}
    >
      {state === 'fail' ? (
        <RiCloseLine size={10} />
      ) : state === 'now' ? (
        <span className="size-1.5 rounded-full bg-current" />
      ) : (
        <RiCheckLine size={10} />
      )}
    </span>
  </span>
);

const StepRow = observer(({ step }: { step: Step }) => {
  // A failure opens itself. Everything else waits to be asked.
  const [open, setOpen] = React.useState(step.failed);
  const expandable = step.targets.length > 1 || Boolean(step.output);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen(!open)}
        className={cn(
          'flex min-w-0 items-center gap-2 rounded px-2 py-1 text-left',
          expandable && 'hover:bg-grayAlpha-100',
          step.failed && 'text-destructive',
        )}
      >
        <StepIcon step={step} />

        <span className="min-w-0 grow truncate">{phrase(step)}</span>

        {step.count > 1 && (
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {step.count}
          </span>
        )}

        {expandable &&
          (open ? (
            <RiArrowDownSLine
              size={12}
              className="shrink-0 text-muted-foreground"
            />
          ) : (
            <RiArrowRightSLine
              size={12}
              className="shrink-0 text-muted-foreground"
            />
          ))}
      </button>

      {open && step.targets.length > 1 && (
        <ul className="ml-7 flex flex-col gap-0.5 border-l border-border pl-3">
          {step.targets.map((target, index) => (
            <li
              key={`${target}-${index}`}
              className="truncate font-mono text-xs text-muted-foreground"
            >
              {target}
            </li>
          ))}
        </ul>
      )}

      {open && step.output && (
        <pre className="ml-7 my-1 max-h-64 overflow-auto rounded bg-grayAlpha-100 p-2 font-mono text-xs whitespace-pre-wrap">
          {step.output}
        </pre>
      )}
    </div>
  );
});

const StepIcon = ({ step }: { step: Step }) => {
  const className = cn(
    'shrink-0',
    step.failed ? 'text-destructive' : 'text-muted-foreground',
  );

  switch (step.kind) {
    case 'read':
      return <RiFileTextLine size={13} className={className} />;
    case 'write':
      return <RiEditLine size={13} className={className} />;
    case 'search':
      return <RiSearchLine size={13} className={className} />;
    case 'test':
      return step.failed ? (
        <RiCloseLine size={13} className={className} />
      ) : (
        <RiCheckLine size={13} className={className} />
      );
    case 'bash':
      return <RiCodeSSlashLine size={13} className={className} />;
    default:
      // No kind, or one this bundle has never heard of. The row still appears,
      // carrying its message — an older run, or a newer harness, must not
      // produce a blank timeline.
      return <span className={cn(className, 'w-[13px]')} />;
  }
};

export interface Step {
  id: string;
  kind?: string;
  /** What the harness said, and the only thing an unknown kind can show. */
  message: string;
  targets: string[];
  command?: string;
  count: number;
  failed: boolean;
  output?: string;
  exit?: number;
  /** Test counts, when the run's reporter stated them. */
  passed?: number;
  failedCount?: number;
}

/** The kinds where four in a row are one fact, not four. */
const MERGES = ['read', 'search'];

/**
 * Events into steps.
 *
 * Two transformations, both of which need the events in order. An outcome
 * event carrying a `ref` is not a step of its own — it is the ending of one
 * already on screen, so it is folded back into it. And adjacent steps of a
 * mergeable kind collapse into one row that counts them.
 */
export function toSteps(events: any[]): Step[] {
  const steps: Step[] = [];
  const byRef = new Map<string, Step>();

  for (const event of events) {
    const data = (event.data ?? undefined) as
      | {
          kind?: string;
          ref?: string;
          target?: string;
          command?: string;
          ok?: boolean;
          exit?: number;
          output?: string;
          passed?: number;
          failed?: number;
        }
      | undefined;

    // The ending of a step already reported. Never its own row: the step is
    // where the reader is looking, and a second line saying the same call also
    // finished is the log this screen exists to replace.
    if (data?.ok != null && data.ref) {
      const started = byRef.get(data.ref);

      if (started) {
        started.failed = data.ok === false;
        started.output = data.output;
        started.exit = data.exit;
        started.passed = data.passed;
        started.failedCount = data.failed;
        continue;
      }
    }

    const detail = data?.target ?? data?.command;
    const previous = steps[steps.length - 1];

    if (
      data?.kind &&
      MERGES.includes(data.kind) &&
      previous?.kind === data.kind &&
      !previous.failed
    ) {
      previous.count += 1;
      if (detail) {
        previous.targets.push(detail);
      }
      continue;
    }

    const step: Step = {
      id: event.id,
      kind: data?.kind,
      message: event.message,
      targets: detail ? [detail] : [],
      command: data?.command,
      count: 1,
      failed: event.level === 'ERROR',
      ...(data?.output ? { output: data.output } : {}),
      ...(data?.exit != null ? { exit: data.exit } : {}),
    };

    steps.push(step);

    if (data?.ref) {
      byRef.set(data.ref, step);
    }
  }

  return steps;
}

/** A step said the way a person would say it. */
export function phrase(step: Step): string {
  const first = step.targets[0];

  switch (step.kind) {
    case 'read':
      if (!first) {
        return 'Read a file';
      }
      return step.count > 1
        ? `Read ${basename(first)} and ${step.count - 1} more`
        : `Read ${basename(first)}`;

    case 'write':
      return first ? `Wrote ${basename(first)}` : 'Wrote a file';

    case 'search':
      if (!first) {
        return 'Searched the code';
      }
      return step.count > 1
        ? `Searched for ${first} and ${step.count - 1} more`
        : `Searched for ${first}`;

    case 'test':
      if (step.failed) {
        return step.failedCount != null
          ? `Ran the tests — ${step.failedCount} failed`
          : 'Ran the tests — failed';
      }
      return step.passed != null
        ? `Ran the tests — ${step.passed} passed`
        : 'Ran the tests';

    case 'bash':
      return step.command ?? step.message;

    default:
      return step.message;
  }
}

/** The end of a path, which is the part that identifies it to a reader. */
function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/**
 * Events into phases, in the order the run moves through them.
 *
 * An event with no phase, or one this bundle has never heard of, keeps its own
 * group at the end rather than being dropped: a newer server can emit a phase
 * this client does not know, and losing those lines would lose exactly the
 * progress a reader came for.
 */
function groupByPhase(events: any[]): Array<{ phase: string; lines: any[] }> {
  const groups = new Map<string, any[]>();

  for (const event of events) {
    const phase = event.phase || 'progress';
    const existing = groups.get(phase);

    if (existing) {
      existing.push(event);
    } else {
      groups.set(phase, [event]);
    }
  }

  return [...groups.entries()]
    .map(([phase, lines]) => ({ phase, lines }))
    .sort((a, b) => rank(a.phase) - rank(b.phase));
}

function rank(phase: string): number {
  const index = PHASE_ORDER.indexOf(phase);
  return index === -1 ? PHASE_ORDER.length : index;
}

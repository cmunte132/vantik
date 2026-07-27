/* eslint-disable @typescript-eslint/no-explicit-any */
import { Badge } from '@vantikhq/ui/components/badge';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@vantikhq/ui/components/collapsible';
import { ChevronDown, ChevronRight } from '@vantikhq/ui/icons';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import React from 'react';

import { PHASE_LABEL, PHASE_ORDER, isLive } from './run-vocabulary';

interface Props {
  run: any;
  events: any[];
}

/**
 * What the agent did, as the phases it moved through rather than as a log.
 *
 * A raw transcript is the thing this screen exists not to be. The events
 * already carry the phase the runner was in, so they group into steps a person
 * thinks in — set up, do the work, run the checks, hand it back — and each one
 * collapses to a heading with a count and a duration. Scanning a finished run,
 * the questions are which phase took the time and which one broke, and neither
 * is answerable from a flat list of lines.
 *
 * The phase still running stays open. Finished phases start closed, because a
 * finished phase is a heading and a duration until somebody asks for more.
 */
export const RunTimeline = observer(({ run, events }: Props) => {
  const phases = groupByPhase(events);
  const live = isLive(run.status);
  const timings = (run.phaseTimings ?? {}) as Record<string, number>;

  if (phases.length === 0) {
    return (
      <p className="p-3 text-muted-foreground">
        {live
          ? 'Waiting for the runner to report something.'
          : 'This run recorded no progress events.'}
      </p>
    );
  }

  const lastPhase = phases[phases.length - 1]?.phase;

  return (
    <div className="flex flex-col divide-y divide-border">
      {phases.map(({ phase, lines }) => (
        <Phase
          key={phase}
          phase={phase}
          lines={lines}
          durationMs={timings[phase]}
          defaultOpen={live && phase === lastPhase}
        />
      ))}
    </div>
  );
});

const Phase = observer(
  ({
    phase,
    lines,
    durationMs,
    defaultOpen,
  }: {
    phase: string;
    lines: any[];
    durationMs?: number;
    defaultOpen: boolean;
  }) => {
    const [open, setOpen] = React.useState(defaultOpen);
    const broke = lines.some((line) => line.level === 'ERROR');

    return (
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-grayAlpha-100">
          {open ? (
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
          )}

          <span className={cn('grow truncate', broke && 'text-destructive')}>
            {PHASE_LABEL[phase] ?? phase}
          </span>

          {durationMs ? (
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {Math.round(durationMs / 1000)}s
            </span>
          ) : null}

          <Badge variant="secondary" className="shrink-0">
            {lines.length}
          </Badge>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <ul className="flex flex-col gap-0.5 px-3 pb-3 pl-8">
            {lines.map((line) => (
              <li
                key={line.id}
                className={cn(
                  'font-mono text-xs leading-relaxed text-muted-foreground',
                  line.level === 'ERROR' && 'text-destructive',
                  line.level === 'WARN' && 'text-amber-600 dark:text-amber-500',
                )}
              >
                {line.message}
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    );
  },
);

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

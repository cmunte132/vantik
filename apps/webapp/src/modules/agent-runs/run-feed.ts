/* eslint-disable @typescript-eslint/no-explicit-any */
import { isLive, splitPhase } from './run-vocabulary';

/**
 * What a run's events mean, apart from how they are drawn.
 *
 * The run page reads the same events four ways: as steps in the activity feed,
 * as the five stages at the top, as the step in flight, and as the files the
 * run changed. All four are worked out here, from the events in order, so that
 * `run-feed.spec.ts` can test them without a screen.
 */

export interface Step {
  id: string;
  /** When the step started, as the event's ISO time. */
  at?: string;
  phase?: string;
  kind?: string;
  /** What the harness said, and the only thing an unknown kind can show. */
  message: string;
  targets: string[];
  command?: string;
  count: number;
  failed: boolean;
  /** True once an outcome event has ended the step. */
  ended: boolean;
  output?: string;
  exit?: number;
  /** Test counts, when the run's reporter stated them. */
  passed?: number;
  failedCount?: number;
  /** A note: what the agent said. */
  text?: string;
  /** A write: the lines it added and removed, and the start of its diff. */
  added?: number;
  removed?: number;
  diff?: string;
  /** True for an edit of an existing file, as opposed to a whole new one. */
  edited?: boolean;
  /** A question to a person: the record that holds the question and answer. */
  agentQuestionId?: string;
  /** A note the person wrote in their own terminal, as opposed to the agent. */
  role?: string;
}

/** The kinds where four in a row are one fact, not four. */
const MERGES = ['read', 'search'];

interface StepData {
  kind?: string;
  ref?: string;
  target?: string;
  command?: string;
  ok?: boolean;
  exit?: number;
  output?: string;
  passed?: number;
  failed?: number;
  text?: string;
  added?: number;
  removed?: number;
  diff?: string;
  agentQuestionId?: string;
  role?: string;
}

/** The phase of the steps that a person did in their own terminal. */
export const TERMINAL_PHASE = 'terminal';

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
    const data = (event.data ?? undefined) as StepData | undefined;

    // The ending of a step already reported. Never its own row: the step is
    // where the reader is looking, and a second line saying the same call also
    // finished is the log this screen exists to replace.
    if (data?.ok != null && data.ref) {
      const started = byRef.get(data.ref);

      if (started) {
        started.ended = true;
        started.failed = data.ok === false;
        started.output = data.output;
        started.exit = data.exit;
        started.passed = data.passed;
        started.failedCount = data.failed;
        if (data.diff != null) {
          started.diff = data.diff;
          started.added = data.added;
          started.removed = data.removed;
        }
        continue;
      }
    }

    const detail = data?.target ?? data?.command;
    const previous = steps[steps.length - 1];

    if (
      data?.kind &&
      MERGES.includes(data.kind) &&
      previous?.kind === data.kind &&
      previous.phase === event.phase &&
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
      at: event.at,
      phase: event.phase ?? undefined,
      kind: data?.kind,
      message: event.message,
      targets: detail ? [detail] : [],
      command: data?.command,
      count: 1,
      failed: event.level === 'ERROR',
      ended: data?.ok != null,
      ...(data?.output ? { output: data.output } : {}),
      ...(data?.exit != null ? { exit: data.exit } : {}),
      ...(data?.passed != null ? { passed: data.passed } : {}),
      ...(data?.kind === 'note' ? { text: data.text ?? event.message } : {}),
      ...(data?.role ? { role: data.role } : {}),
      ...(data?.added != null ? { added: data.added } : {}),
      ...(data?.removed != null ? { removed: data.removed } : {}),
      ...(data?.diff ? { diff: data.diff } : {}),
      ...(data?.kind === 'question' && data.agentQuestionId
        ? { agentQuestionId: data.agentQuestionId }
        : {}),
      ...(data?.kind === 'write' && /^edit\b/i.test(event.message ?? '')
        ? { edited: true }
        : {}),
    };

    steps.push(step);

    if (data?.ref) {
      byRef.set(data.ref, step);
    }
  }

  return steps;
}

/** A step said the way a person would say it, once it has happened. */
export function phrase(step: Step): string {
  const first = step.targets[0];

  switch (step.kind) {
    case 'read':
      if (!first) {
        return 'Read a file';
      }
      return step.count > 1
        ? `Read ${step.count} files`
        : `Read ${basename(first)}`;

    case 'write':
      if (!first) {
        return step.edited ? 'Edited a file' : 'Wrote a file';
      }
      return `${step.edited ? 'Edited' : 'Wrote'} ${basename(first)}`;

    case 'search':
      if (!first) {
        return 'Searched the code';
      }
      return step.count > 1
        ? `Searched ${step.count} times`
        : `Searched for ${first}`;

    case 'test':
      // The counts are the step's detail line, not its name.
      if (step.failed) {
        return 'Tests failed';
      }
      return step.passed != null ? 'Tests passed' : 'Ran the tests';

    case 'bash':
      return step.failed ? 'A command failed' : 'Ran a command';

    case 'note':
      return step.text ?? step.message;

    default:
      return step.message;
  }
}

/** The same step while it is still going, for the card that says what is happening now. */
export function doing(step: Step): string {
  const first = step.targets[0];

  switch (step.kind) {
    case 'read':
      return first ? `Reading ${basename(first)}` : 'Reading the code';
    case 'write':
      return first
        ? `${step.edited ? 'Editing' : 'Writing'} ${basename(first)}`
        : 'Writing a file';
    case 'search':
      return first ? `Searching for ${first}` : 'Searching the code';
    case 'test':
      return 'Running the tests';
    case 'bash':
      return 'Running a command';
    case 'note':
      return 'Deciding what to do next';
    case 'question':
      return 'Waiting for a person to answer';
    default:
      return step.message;
  }
}

/** The end of a path, which is the part that identifies it to a reader. */
export function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/**
 * One row of the activity feed.
 *
 * Setting up the environment is several lines nobody reads one at a time, so it
 * is one row that lists them. Everything else is a step.
 */
export type FeedItem =
  | {
      type: 'setup';
      id: string;
      at?: string;
      lines: string[];
      failed: boolean;
    }
  | { type: 'step'; id: string; at?: string; step: Step }
  /** Where a person went on in their own terminal; the rows after it are theirs. */
  | { type: 'terminal'; id: string; at?: string };

export function toFeed(events: any[]): FeedItem[] {
  const feed: FeedItem[] = [];
  let inTerminal = false;

  for (const step of toSteps(events)) {
    const previous = feed[feed.length - 1];

    if (splitPhase(step.phase ?? '').base === 'setup') {
      if (previous?.type === 'setup') {
        previous.lines.push(step.message);
        previous.failed = previous.failed || step.failed;
      } else {
        feed.push({
          type: 'setup',
          id: step.id,
          at: step.at,
          lines: [step.message],
          failed: step.failed,
        });
      }
      continue;
    }

    // One heading where the person's terminal work starts. The work is in the
    // same feed as the run's own, in the order it happened.
    const fromTerminal = step.phase === TERMINAL_PHASE;
    if (fromTerminal && !inTerminal) {
      feed.push({ type: 'terminal', id: `terminal-${step.id}`, at: step.at });
    }
    inTerminal = fromTerminal;

    feed.push({ type: 'step', id: step.id, at: step.at, step });
  }

  return feed;
}

export const FILTERS = ['All', 'Edits', 'Commands', 'Agent notes'] as const;
export type Filter = (typeof FILTERS)[number];

/** Whether a feed row belongs under a filter. */
export function matches(item: FeedItem, filter: Filter): boolean {
  if (filter === 'All') {
    return true;
  }
  if (item.type !== 'step') {
    return false;
  }

  const { kind } = item.step;

  // A question to a person blocks the run, so no filter hides it.
  if (kind === 'question') {
    return true;
  }

  switch (filter) {
    case 'Edits':
      return kind === 'write';
    case 'Commands':
      return kind === 'bash' || kind === 'test';
    case 'Agent notes':
      return kind === 'note';
  }

  return false;
}

/**
 * The step in flight, when there is one.
 *
 * Pi reports a tool call when it starts and reports an ending only for a
 * failure, a test count or an edit, so "in flight" means the last thing the
 * run said, while the run is still going.
 */
export function inFlight(run: any, feed: FeedItem[]): FeedItem | null {
  if (!isLive(run.status)) {
    return null;
  }

  return feed[feed.length - 1] ?? null;
}

/** Seconds since the run started, as `m:ss`, for the feed's time column. */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, '0');

  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}`
    : `${minutes}:${rest}`;
}

/** When the run's own clock started. */
export function runStart(run: any): number {
  return Date.parse(run.startedAt ?? run.createdAt);
}

export type StageState = 'done' | 'now' | 'fail' | 'todo' | 'skipped';

export interface Stage {
  label: string;
  state: StageState;
  ms?: number;
}

const STAGE_LABELS = ['Set up', 'Work', 'Check', 'Review', 'Hand back'];

/**
 * Which of the five stages a phase is part of.
 *
 * `implement` and `revise` are both the work: the first pass implements, every
 * later one revises what the reviewer found. A phase this bundle does not know
 * belongs to none of them.
 */
export function stageOf(phase: string | null | undefined): number | null {
  switch (splitPhase(phase ?? '').base) {
    case 'setup':
      return 0;
    case 'implement':
    case 'revise':
      return 1;
    case 'verify':
      return 2;
    case 'review':
      return 3;
    case 'report':
      return 4;
    default:
      return null;
  }
}

/**
 * The five stages at the top of the page, and where the run is in them.
 *
 * Times come from the run's recorded phase timings, summed over every pass. A
 * pass records its timings only when it ends, so the stage in flight is timed
 * from its first event instead.
 */
export function stagesOf(run: any, events: any[], now = Date.now()): Stage[] {
  const timings = (run.phaseTimings ?? {}) as Record<string, number>;
  const live = isLive(run.status);
  const seen = new Set<number>();
  let current: number | null = null;
  let currentSince: string | undefined;

  for (const event of events) {
    const stage = stageOf(event.phase);
    if (stage == null) {
      continue;
    }
    seen.add(stage);
    if (stage !== current) {
      current = stage;
      currentSince = event.at;
    }
  }

  // A live run that has said nothing yet is setting up.
  if (live && current == null) {
    current = 0;
  }

  const ms: number[] = STAGE_LABELS.map(() => 0);
  for (const [phase, value] of Object.entries(timings)) {
    const stage = stageOf(phase);
    if (stage != null && typeof value === 'number') {
      ms[stage] += value;
    }
  }

  if (live && current != null && currentSince && !ms[current]) {
    ms[current] = Math.max(0, now - Date.parse(currentSince));
  }

  // A run on the person's own machine has no host-side check pass and no
  // reviewer: the agent runs the checks in its own turn. Showing those stages
  // would only ever show them waiting.
  const shown = (index: number) =>
    !(run.executor === 'local' && (index === 2 || index === 3));

  return STAGE_LABELS.flatMap((label, index): Stage[] => {
    if (!shown(index)) {
      return [];
    }
    let state: StageState;

    if (live) {
      state = index === current ? 'now' : seen.has(index) ? 'done' : 'todo';
    } else if (run.status === 'SUCCEEDED' || run.status === 'NEEDS_REVIEW') {
      state = seen.has(index) ? 'done' : 'skipped';
    } else if (index === current) {
      // Where a failed or stopped run was when it ended.
      state = run.status === 'CANCELED' ? 'todo' : 'fail';
    } else if (current != null && index < current) {
      state = seen.has(index) ? 'done' : 'skipped';
    } else {
      state = 'todo';
    }

    return [
      {
        label,
        state,
        ...(ms[index] ? { ms: ms[index] } : {}),
      },
    ];
  });
}

export interface FileChange {
  path: string;
  added?: number;
  removed?: number;
}

/**
 * The files the run wrote, with what it added and removed.
 *
 * Summed over every write to the same path. A count is missing when no write
 * to that file reported one, which is what an older run looks like.
 */
export function changesOf(steps: Step[]): FileChange[] {
  const files = new Map<string, FileChange>();

  for (const step of steps) {
    if (step.kind !== 'write' || step.failed || !step.targets[0]) {
      continue;
    }

    const path = step.targets[0];
    const file = files.get(path) ?? { path };

    if (step.added != null) {
      file.added = (file.added ?? 0) + step.added;
    }
    if (step.removed != null) {
      file.removed = (file.removed ?? 0) + step.removed;
    }

    files.set(path, file);
  }

  return [...files.values()];
}

/** One line of a diff preview. */
export function diffLines(
  diff: string,
): Array<{ mark: '+' | '-' | ' '; text: string }> {
  return diff.split('\n').map((line) => {
    const mark = line[0];

    return mark === '+' || mark === '-'
      ? { mark, text: line.slice(1) }
      : { mark: ' ', text: mark === ' ' ? line.slice(1) : line };
  });
}

/** The pull request's number, from its url. */
export function pullNumber(url: string | undefined): string | null {
  const match = url ? /\/(?:pull|pulls|merge_requests)\/(\d+)/.exec(url) : null;
  return match ? match[1] : null;
}

import type { AgentStepKind } from '@vantikhq/types';

/**
 * What Pi's JSON event stream says a run did.
 *
 * The sandbox streams the harness's output while it runs, and `PiEventReader`
 * turns it into steps a line at a time, so the timeline fills in as the agent
 * works. `parsePiEvents` is the same reader over a whole stream at once.
 *
 * A reader must not be able to tell from the timeline which backend produced
 * it, so the mapping lives here rather than in any one executor and
 * `pi-events.spec.ts` asserts the shapes
 * both are written against.
 */
export interface ParsedStep {
  message: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  phase: string;
  data?: Record<string, unknown>;
}

/**
 * The model call itself failing, as opposed to the agent doing badly.
 *
 * A bad model id, a rejected key, a rate limit or a provider outage all land
 * here — and none of them make the harness exit non-zero, so without this the
 * caller cannot tell "the agent had nothing to say" from "nothing ever
 * answered".
 */
export interface RunFailure {
  /** Pi's own stop reason. `error` is the only one that lands here. */
  reason: string;
  /** The provider's message, e.g. `400: … is not a valid model ID`. */
  message: string;
}

export interface ParsedRun {
  steps: ParsedStep[];
  /** The agent's own closing prose. What the handback comment is rendered from. */
  summary: string | null;
  /** The model that actually answered, which is not always the one asked for. */
  modelId: string | null;
  costUsd: number;
  /** Assistant turns, for the record on the run. */
  iterations: number;
  /**
   * Why the last model call did not answer, when it did not.
   *
   * Null on a run that ended normally, *including* one that failed a call
   * partway and recovered — Pi retries, and a transient error the retry fixed
   * is not a reason to throw away the work that followed it.
   */
  failure: RunFailure | null;
}

/**
 * Reads one run's stdout.
 *
 * Never throws. A stream that is truncated, interleaved with a stray line of
 * prose, or half a record long is the normal case for a command whose output
 * was capped, and a parser that dies on it loses the whole run's history to
 * report a formatting complaint.
 */
export function parsePiEvents(stdout: string): ParsedRun {
  const reader = new PiEventReader();

  reader.push(stdout);
  reader.flush();

  return reader.result();
}

/**
 * Reads Pi's event stream as it arrives, a chunk at a time.
 *
 * The sandbox streams the harness's stdout while it runs, so each step can
 * reach the timeline while the agent is still working. `push` gives the steps
 * of the lines that a chunk completed; a line split across two chunks is held
 * until its end arrives. `result` is what `parsePiEvents` gives for the same
 * text, whatever the chunks were.
 */
export class PiEventReader {
  private pending = '';
  private readonly steps: ParsedStep[] = [];
  private readonly assistantText: string[] = [];
  private modelId: string | null = null;
  private costUsd = 0;
  private iterations = 0;
  // Overwritten by every settled message, so what survives is the state of the
  // *last* one. That is what makes a retried call that then answered read as a
  // success rather than as the error it recovered from.
  private failure: RunFailure | null = null;
  private seen = false;

  /**
   * `observe` sees every event the stream carried, parsed, before it is turned
   * into a step — which is how the run's trace gets its model and tool calls
   * without a second parser.
   */
  constructor(private readonly observe?: (event: PiEvent) => void) {}

  /** True once any output has arrived. */
  get received(): boolean {
    return this.seen;
  }

  /** What the messages read so far cost, and how many turns they took. */
  get spent(): { costUsd: number; turns: number } {
    return { costUsd: this.costUsd, turns: this.iterations };
  }

  /** The steps of every line this chunk completed. */
  push(chunk: string): ParsedStep[] {
    if (chunk) {
      this.seen = true;
    }

    // Split on LF and nothing else, the same as the RPC framing rule: U+2028
    // and U+2029 are legal inside a JSON string, and a generic line reader
    // would break one record into two and lose it.
    const lines = (this.pending + chunk).split('\n');
    this.pending = lines.pop() ?? '';

    return lines.flatMap((line) => this.read(line));
  }

  /** The steps of a last line that no LF ended. */
  flush(): ParsedStep[] {
    const line = this.pending;
    this.pending = '';

    return this.read(line);
  }

  result(): ParsedRun {
    return {
      steps: [...this.steps],
      // The last thing it said, which is where the closing report is. Earlier
      // messages are narration between tool calls and reporting them as the
      // result of the run would bury the part somebody has to read.
      summary: this.assistantText.length
        ? (this.assistantText[this.assistantText.length - 1]
            ?.trim()
            .slice(0, 4000) ?? null)
        : null,
      modelId: this.modelId,
      costUsd: this.costUsd,
      iterations: this.iterations,
      failure: this.failure,
    };
  }

  private read(line: string): ParsedStep[] {
    const event = parseLine(line);

    if (!event) {
      return [];
    }

    this.observe?.(event);

    if (event.type === 'turn_end') {
      this.iterations += 1;
    }

    // `message_end` rather than `turn_end`, which carries the same message a
    // second time, or `message_start`, which reports an error before the retry
    // that may clear it.
    if (event.type === 'message_end') {
      this.failure = failureOf(event);
    }

    const model = modelOf(event);
    if (model) {
      this.modelId = model;
    }

    this.costUsd += costOf(event);

    const text = assistantTextOf(event);
    if (text) {
      this.assistantText.push(text);
    }

    const step = describe(event);
    if (!step) {
      return [];
    }

    this.steps.push(step);

    return [step];
  }
}

/**
 * A settled message that never got an answer.
 *
 * Pi reports this on the message and still exits zero, so the whole difference
 * between "the model refused" and "the agent finished quietly" is these two
 * fields.
 */
export function failureOf(event: PiEvent): RunFailure | null {
  const message = event.message as
    { stopReason?: unknown; errorMessage?: unknown } | undefined;

  if (message?.stopReason !== 'error') {
    return null;
  }

  return {
    reason: 'error',
    message:
      typeof message.errorMessage === 'string' && message.errorMessage.trim()
        ? message.errorMessage.trim().slice(0, 1000)
        : 'The model call failed, and the harness did not say why.',
  };
}

export type PiEvent = Record<string, unknown>;

function parseLine(line: string): PiEvent | null {
  const trimmed = line.trim();

  if (!trimmed.startsWith('{')) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as PiEvent)
      : null;
  } catch {
    return null;
  }
}

/** Turns one harness event into a progress line worth storing, or nothing. */
export function describe(event: PiEvent): ParsedStep | null {
  const type = String(event.type ?? '');

  if (type === 'tool_execution_start') {
    const name = String(event.toolName ?? 'a tool');
    const detail = describeToolArgs(event.args);
    const kind = kindOf(name, detail);
    // A new file's size is known before the tool runs. An edit's is not: it is
    // counted from the diff the tool reports when it ends.
    const written =
      name.toLowerCase() === 'write' ? lineCountOf(event.args) : undefined;

    return {
      message: detail ? `${name}: ${detail}` : `Running ${name}`,
      level: 'INFO',
      phase: 'implement',
      data: {
        kind,
        ...(event.toolCallId ? { ref: String(event.toolCallId) } : {}),
        ...(detail
          ? kind === 'bash' || kind === 'test'
            ? { command: detail }
            : { target: detail }
          : {}),
        ...(written == null ? {} : { added: written }),
      },
    };
  }

  // An edit that landed. Its diff is the most useful thing a reader can see
  // about it, and the tool has already worked it out.
  if (type === 'tool_execution_end' && !event.isError) {
    const diff = diffOf(event.result);

    if (diff) {
      return {
        message: `${String(event.toolName ?? 'edit')} finished`,
        level: 'INFO',
        phase: 'implement',
        data: {
          kind: 'write' as AgentStepKind,
          ...(event.toolCallId ? { ref: String(event.toolCallId) } : {}),
          ok: true,
          ...diff,
        },
      };
    }
  }

  // A test result that passed, which is the one success worth a second event.
  // Recognised from the output rather than from the tool name, because at this
  // point the command is no longer in hand — output that states a pass count is
  // a test result whatever ran it.
  if (type === 'tool_execution_end' && !event.isError) {
    const counts = testCountsOf(textOf(event.result));

    return counts
      ? {
          message: `Tests passed: ${counts.passed}`,
          level: 'INFO',
          phase: 'implement',
          data: {
            kind: 'test' as AgentStepKind,
            ...(event.toolCallId ? { ref: String(event.toolCallId) } : {}),
            ok: true,
            ...counts,
          },
        }
      : null;
  }

  if (type === 'tool_execution_end' && event.isError) {
    const name = String(event.toolName ?? 'a tool');
    const output = textOf(event.result);
    const exit = exitCodeOf(output);

    return {
      message: `${name} failed`,
      level: 'ERROR',
      phase: 'implement',
      data: {
        kind: kindOf(name, null),
        ...(event.toolCallId ? { ref: String(event.toolCallId) } : {}),
        ok: false,
        ...(exit == null ? {} : { exit }),
        ...(output ? { output: output.slice(-OUTPUT_LIMIT) } : {}),
      },
    };
  }

  // What the agent says between tool calls: why it is about to do something,
  // or what it found. That is the part of a run a person can follow without
  // reading the tool calls themselves.
  const text = assistantTextOf(event);
  if (text) {
    return {
      message: (text.split('\n')[0] ?? '').slice(0, 200),
      level: 'INFO',
      phase: 'implement',
      data: { kind: 'note' as AgentStepKind, text: text.slice(0, NOTE_LIMIT) },
    };
  }

  if (type === 'auto_retry_start') {
    return {
      message: 'The model call failed; retrying',
      level: 'WARN',
      phase: 'implement',
    };
  }

  if (type === 'compaction_start') {
    return {
      message: 'Compacting the context',
      level: 'INFO',
      phase: 'implement',
    };
  }

  // `turn_end` is deliberately not a progress line. Pi emits one after every
  // tool call, and a run of any length would say "Finished a turn" more often
  // than it said anything else. The turn still counts towards iterations; it
  // just is not something the agent *did*.
  return null;
}

/** How much of a failing command's output is worth keeping. */
const OUTPUT_LIMIT = 2000;

/** How much of one thing the agent said is worth keeping. */
const NOTE_LIMIT = 2000;

/** How much of an edit's diff is kept, in lines and in characters. */
const DIFF_LINES = 40;
const DIFF_CHARS = 4000;

/** The lines of a new file, from the `write` tool's arguments. */
function lineCountOf(args: unknown): number | undefined {
  const content = (args as { content?: unknown } | null)?.content;

  if (typeof content !== 'string') {
    return undefined;
  }

  return content ? content.replace(/\n$/, '').split('\n').length : 0;
}

/**
 * An edit's diff, from the tool's own report of it.
 *
 * Pi's edit tool puts the diff at `details.diff`, one line each: `+N text` for
 * an added line, `-N text` for a removed one, ` N text` for context, and a line
 * of `...` for unchanged lines it left out. The counts are over the whole diff;
 * the preview keeps its start, without the line numbers.
 */
function diffOf(
  result: unknown,
): { added: number; removed: number; diff: string } | null {
  const diff = (result as { details?: { diff?: unknown } } | null)?.details
    ?.diff;

  if (typeof diff !== 'string' || !diff.trim()) {
    return null;
  }

  let added = 0;
  let removed = 0;
  const preview: string[] = [];
  let length = 0;

  for (const line of diff.split('\n')) {
    const match = /^([+\- ])\s*\d+ (.*)$/.exec(line);
    const mark = match ? match[1] : ' ';
    const body = match ? match[2] : line.trim() === '...' ? '…' : line.trim();

    if (mark === '+') {
      added += 1;
    } else if (mark === '-') {
      removed += 1;
    }

    const kept = `${mark}${body.slice(0, 200)}`;

    if (preview.length < DIFF_LINES && length + kept.length <= DIFF_CHARS) {
      preview.push(kept);
      length += kept.length + 1;
    }
  }

  return { added, removed, diff: preview.join('\n') };
}

/**
 * Which of the five kinds a tool is.
 *
 * Pi's own tool set — bash, edit, find, grep, ls, read, write — maps onto them
 * exactly. Anything a future Pi adds falls through to `bash`, and a client that
 * cannot draw a kind it does not know still has the message.
 */
function kindOf(toolName: string, detail: string | null): AgentStepKind {
  const name = toolName.toLowerCase();

  if (name === 'read' || name === 'ls') {
    return 'read';
  }
  if (name === 'write' || name === 'edit') {
    return 'write';
  }
  if (name === 'grep' || name === 'find') {
    return 'search';
  }

  // A test run is a bash call that matters more than the others: it is the step
  // a reader looks for first, and the one whose failure they came to see.
  // Recognised by shape rather than by comparing against the configured test
  // command, because an agent runs one suite, one file and one case, and only
  // the first of those would ever match.
  return detail && TEST_COMMAND.test(detail) ? 'test' : 'bash';
}

const TEST_COMMAND =
  /(^|\s|\/)(jest|vitest|pytest|rspec|mocha|ava|phpunit)(\s|$)|\b(test|tests)\b/i;

/** The one fact about a tool call worth a log line: what it acted on. */
function describeToolArgs(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) {
    return null;
  }

  const record = args as Record<string, unknown>;
  const interesting =
    record.command ?? record.path ?? record.file_path ?? record.pattern;

  return typeof interesting === 'string'
    ? (interesting.split('\n')[0] ?? '').slice(0, 120) || null
    : null;
}

/** A tool result as text, whatever shape the harness reported it in. */
function textOf(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }

  if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content;

    if (Array.isArray(content)) {
      return content
        .map((part) =>
          part && typeof part === 'object'
            ? String((part as { text?: unknown }).text ?? '')
            : '',
        )
        .join('\n')
        .trim();
    }

    const text = (result as { text?: unknown }).text;
    if (typeof text === 'string') {
      return text;
    }
  }

  return '';
}

/**
 * Pass and fail counts, when the output stated them.
 *
 * Every runner words its summary differently — `6 passed`, `Tests: 6 passed`,
 * `6 passing` — but all of them put the number immediately beside the word,
 * which is the only part worth relying on.
 */
function testCountsOf(
  output: string,
): { passed: number; failed?: number } | null {
  const passed = /(\d+) (?:passed|passing)\b/i.exec(output);

  if (!passed) {
    return null;
  }

  const failed = /(\d+) (?:failed|failing)\b/i.exec(output);

  return {
    passed: Number(passed[1]),
    ...(failed ? { failed: Number(failed[1]) } : {}),
  };
}

/**
 * The exit code Pi's bash tool states in the text it throws.
 *
 * It reports failure by throwing `…Command exited with code N` rather than by
 * carrying a status field, so this is where the number is.
 */
function exitCodeOf(output: string): number | undefined {
  const match = /Command exited with code (\d+)/.exec(output);
  return match ? Number(match[1]) : undefined;
}

/**
 * The model that actually answered.
 *
 * Read off the message rather than trusted from the flag: `--model` is a
 * pattern Pi resolves against what the provider offers, so the id that ran is
 * not always the id that was asked for, and the whole point of recording it is
 * that two runs can be compared afterwards.
 */
export function modelOf(event: PiEvent): string | null {
  if (typeof event.model === 'string') {
    return event.model;
  }

  const message = event.message as { model?: unknown } | undefined;

  return typeof message?.model === 'string' ? message.model : null;
}

/**
 * What one message cost, when the provider reported it.
 *
 * Read only off an assistant's `message_end`. Pi puts the same message, usage
 * and all, on `message_start`, on every `message_update` while it streams and
 * again on `turn_end`, so summing every event that carries a message counted
 * each call several times — a run that cost $0.17 at the provider reported
 * $0.61.
 */
function costOf(event: PiEvent): number {
  if (event.type !== 'message_end') {
    return 0;
  }

  const message = event.message as
    { role?: unknown; usage?: unknown } | undefined;

  if (message?.role !== 'assistant') {
    return 0;
  }

  const usage = message?.usage as { cost?: { total?: unknown } } | undefined;
  const total = usage?.cost?.total;

  return typeof total === 'number' ? total : 0;
}

/**
 * The assistant's own prose from a finished message.
 *
 * Pi carries it as content blocks on `message_end`, not as a `text` field on a
 * `message` event.
 */
export function assistantTextOf(event: PiEvent): string | null {
  if (event.type !== 'message_end') {
    return null;
  }

  const message = event.message as
    { role?: unknown; content?: unknown } | undefined;

  if (message?.role !== 'assistant' || !Array.isArray(message.content)) {
    return null;
  }

  const text = message.content
    .filter(
      (block: unknown): block is { type: string; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text)
    .join('\n')
    .trim();

  return text || null;
}

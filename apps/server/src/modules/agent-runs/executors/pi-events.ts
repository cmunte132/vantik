import type { AgentStepKind } from '@vantikhq/types';

/**
 * What Pi's JSON event stream says a run did.
 *
 * The sandbox runs the harness as one command and reads its output afterwards,
 * so this is a parser over the whole stream rather than a live tap. That is a
 * real limitation — a hosted run shows nothing until it finishes — but the
 * alternative today is what it replaced: three events per run, none of which
 * said anything the agent did.
 *
 * Kept deliberately close to the equivalent in the BYO runner's `pi-harness`,
 * because a reader must not be able to tell from the timeline which backend
 * produced it. The two cannot share code — the CLI publishes on its own and
 * does not depend on this package — so `pi-events.spec.ts` asserts the shapes
 * both are written against.
 */
export interface ParsedStep {
  message: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  phase: string;
  data?: Record<string, unknown>;
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
  const steps: ParsedStep[] = [];
  const assistantText: string[] = [];
  let modelId: string | null = null;
  let costUsd = 0;
  let iterations = 0;

  // Split on LF and nothing else, the same as the RPC framing rule: U+2028 and
  // U+2029 are legal inside a JSON string, and a generic line reader would
  // break one record into two and lose it.
  for (const line of stdout.split('\n')) {
    const event = parseLine(line);

    if (!event) {
      continue;
    }

    if (event.type === 'turn_end') {
      iterations += 1;
    }

    const model = modelOf(event);
    if (model) {
      modelId = model;
    }

    costUsd += costOf(event);

    const text = assistantTextOf(event);
    if (text) {
      assistantText.push(text);
    }

    const step = describe(event);
    if (step) {
      steps.push(step);
    }
  }

  return {
    steps,
    // The last thing it said, which is where the closing report is. Earlier
    // messages are narration between tool calls and reporting them as the
    // result of the run would bury the part somebody has to read.
    summary: assistantText.length
      ? (assistantText[assistantText.length - 1]?.trim().slice(0, 4000) ?? null)
      : null,
    modelId,
    costUsd,
    iterations,
  };
}

type PiEvent = Record<string, unknown>;

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
      },
    };
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

/** What one message cost, when the provider reported it. */
function costOf(event: PiEvent): number {
  const message = event.message as { usage?: unknown } | undefined;
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

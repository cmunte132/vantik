import type { AgentStepKind } from '@vantikhq/types';

import { type ParsedStep, PiEventReader } from './pi-events';

/**
 * What an omp session file says a person did in their terminal.
 *
 * A session file holds messages, not the event stream of a run. This turns
 * each message into the events that a run would have produced, and reads them
 * with the same `PiEventReader`, so a step from a terminal and a step from a
 * run have the same kinds, messages and data. A reader cannot tell which
 * produced them, except by `phase` and `data.source`, which a caller sets.
 */
export interface SessionStep extends ParsedStep {
  /** When the entry was written. */
  at: Date;
}

export interface ParsedSessionEntries {
  steps: SessionStep[];
  costUsd: number;
  /** Assistant turns. */
  turns: number;
  modelId: string | null;
  /** The newest entry's time, or null when no entry had one. */
  lastAt: Date | null;
}

/** How much of a person's own message is kept in a step. */
const PROMPT_LIMIT = 2000;

type Entry = Record<string, unknown>;

/** The time of an entry: its own ISO stamp, else the message's epoch milliseconds. */
export function entryTime(entry: Entry): Date | null {
  const message = entry.message as { timestamp?: unknown } | undefined;
  for (const value of [entry.timestamp, message?.timestamp]) {
    const time =
      typeof value === 'string' || typeof value === 'number'
        ? new Date(value)
        : null;
    if (time && !Number.isNaN(time.getTime())) {
      return time;
    }
  }
  return null;
}

/** The text of a user message, whether it is a string or content blocks. */
function textOf(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  return Array.isArray(content)
    ? content
        .map((part) =>
          part && typeof part === 'object'
            ? String((part as { text?: unknown }).text ?? '')
            : '',
        )
        .join('')
    : '';
}

/**
 * Reads session file entries, in file order. Never throws: an entry that is
 * not an object, or that has a shape this reader does not know, adds nothing.
 */
export function parseSessionEntries(entries: unknown[]): ParsedSessionEntries {
  const reader = new PiEventReader();
  const steps: SessionStep[] = [];
  let lastAt: Date | null = null;

  for (const raw of entries) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const entry = raw as Entry;
    const at = entryTime(entry) ?? lastAt ?? new Date(0);
    if (!lastAt || at > lastAt) {
      lastAt = at;
    }

    const events: Entry[] = [];
    const message = entry.message as Entry | undefined;

    if (entry.type === 'model_change' && typeof entry.model === 'string') {
      events.push({ type: 'model_change', model: entry.model });
    } else if (entry.type === 'message' && message) {
      if (message.role === 'user') {
        const text = textOf(message.content).trim();
        // omp also records messages that it wrote itself; a person's own
        // carry the attribution `user`, or none.
        const attribution = message.attribution;
        if (text && (attribution === undefined || attribution === 'user')) {
          steps.push({
            at,
            message: (text.split('\n')[0] ?? '').slice(0, 200),
            level: 'INFO',
            phase: 'implement',
            data: {
              kind: 'note' as AgentStepKind,
              text: text.slice(0, PROMPT_LIMIT),
              role: 'user',
            },
          });
        }
      } else if (message.role === 'assistant') {
        events.push({ type: 'message_end', message });
        const blocks = Array.isArray(message.content) ? message.content : [];
        for (const block of blocks as Entry[]) {
          if (block?.type === 'toolCall') {
            events.push({
              type: 'tool_execution_start',
              toolName: block.name,
              toolCallId: block.id,
              args: block.arguments,
            });
          }
        }
        events.push({ type: 'turn_end', message });
      } else if (message.role === 'toolResult') {
        events.push({
          type: 'tool_execution_end',
          toolName: message.toolName,
          toolCallId: message.toolCallId,
          isError: message.isError === true,
          result: { content: message.content, details: message.details },
        });
      }
    }

    if (events.length > 0) {
      const lines = events.map((event) => JSON.stringify(event)).join('\n');
      for (const step of reader.push(`${lines}\n`)) {
        steps.push({ ...step, at });
      }
    }
  }

  const result = reader.result();

  return {
    steps,
    costUsd: result.costUsd,
    turns: result.iterations,
    modelId: result.modelId,
    lastAt,
  };
}

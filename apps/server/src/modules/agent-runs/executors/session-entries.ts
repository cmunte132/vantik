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
  /**
   * Stable for the same step of the same native entry: the entry's name plus
   * the step's index within that entry. Not its position in a batch.
   */
  key: string;
}

export type SessionUsagePurpose = 'assistant' | 'auxiliary' | 'claude_delegate';

/**
 * One model request, or one external Claude result, that the session file
 * records. `id` names the call. The same entry, or the same response, always
 * gives the same id, so a batch that arrives twice names the same calls.
 */
export interface SessionUsageCall {
  id: string;
  /** When the entry was written, or null when the entry has no time. */
  at: Date | null;
  modelId: string | null;
  purpose: SessionUsagePurpose;
  /** The captured amount in USD, or null when the call has no known amount. */
  costUsd: number | null;
  billingMode: 'subscription' | 'metered' | 'unknown';
  costBasis: 'provider_reported' | 'list' | 'harness_estimate' | 'unknown';
  /** Provider, api, response id and delegate facts. No prompts or payloads. */
  provenance: Record<string, unknown>;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * A tool call that names a task: a pickup, or a write to an issue. A read does
 * not name one, so it never moves the work to another issue. `key` is stable
 * for the same tool call in the same entry.
 */
export interface SessionTask {
  key: string;
  at: Date;
  tool: 'pickup' | 'write';
  /** The task as the agent named it: an issue key such as ENG-42, or an id. */
  taskRef: string;
}

export interface ParsedSessionEntries {
  steps: SessionStep[];
  /** The known costs of the calls, summed. A call with no known cost adds nothing. */
  costUsd: number;
  /** Assistant turns. */
  turns: number;
  modelId: string | null;
  /** One entry per call. A mirror of a call that the file already records is not repeated. */
  calls: SessionUsageCall[];
  /** Pickups and issue writes, in file order. */
  tasks: SessionTask[];
  /** The newest entry's time, or null when no entry had one. */
  lastAt: Date | null;
}

type Entry = Record<string, unknown>;

/** The Vantik tools, as omp names them: `mcp__vantik_<tool>`. */
const VANTIK_TOOL_PREFIX = 'mcp__vantik_';
/** How omp's generic `write` wrapper names a Vantik tool in its path. */
const WRITE_PATH_PREFIX = `xd://${VANTIK_TOOL_PREFIX}`;

/** The Vantik tools that name a task, and what each one does to the attribution. */
const TASK_TOOLS: Record<string, SessionTask['tool']> = {
  pick_up_task: 'pickup',
  update_task: 'write',
  update_criteria: 'write',
  add_note: 'write',
  close_task: 'write',
};

/** Providers whose calls the person's own subscription pays for. */
const SUBSCRIPTION_PROVIDERS: Record<string, true> = {
  firstParty: true,
  'openai-codex': true,
  'github-copilot': true,
};

/** How much of a person's own message is kept in a step. */
const PROMPT_LIMIT = 2000;

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A value that is an object, or a string holding a JSON object. */
function jsonObject(value: unknown): Entry | null {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Entry)
        : null;
    } catch {
      return null;
    }
  }
  return typeof value === 'object' && value !== null ? (value as Entry) : null;
}

/** The cost that omp recorded for a request, when it recorded one. */
function costOf(usage: Entry | undefined): number | undefined {
  return finite(
    typeof usage?.cost === 'object' && usage.cost !== null
      ? (usage.cost as Entry).total
      : usage?.cost,
  );
}

/** Drops the keys that have no value, so a stored JSON object has none. */
function definedOnly(value: Entry): Entry {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

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

/**
 * The stable name of an entry: its id. An entry without one is named by a
 * fingerprint of its time and usage, which a replay reproduces exactly. The
 * name never depends on where the entry sits in a batch.
 */
function entryKeyOf(entry: Entry, at: Date | null): string {
  if (typeof entry.id === 'string' && entry.id !== '') {
    return `entry:${entry.id}`;
  }
  const message = entry.message as Entry | undefined;
  const usage = (message?.usage ?? entry.usage) as Entry | undefined;
  return [
    'fp',
    at?.toISOString() ?? '',
    message?.role ?? entry.type ?? '',
    message?.model ?? entry.model ?? '',
    usage?.input ?? '',
    usage?.output ?? '',
    usage?.cacheRead ?? '',
    usage?.cacheWrite ?? '',
    costOf(usage) ?? '',
  ].join('|');
}

/** The task a tool call names, when it is a pickup or an issue write. */
function taskSignalOf(
  block: unknown,
): { tool: SessionTask['tool']; taskRef: string } | null {
  if (typeof block !== 'object' || block === null) {
    return null;
  }
  const call = block as Entry;
  if (call.type !== 'toolCall') {
    return null;
  }

  const name = typeof call.name === 'string' ? call.name : '';
  const args = (call.arguments ?? {}) as Entry;
  let tool: string | undefined;
  let task: unknown;

  if (name.startsWith(VANTIK_TOOL_PREFIX)) {
    tool = name.slice(VANTIK_TOOL_PREFIX.length);
    task = args.task;
  } else if (
    (name === 'write' || name === 'functions.write') &&
    typeof args.path === 'string' &&
    args.path.startsWith(WRITE_PATH_PREFIX)
  ) {
    tool = args.path.slice(WRITE_PATH_PREFIX.length);
    task = jsonObject(args.content)?.task;
  }

  const kind =
    tool !== undefined && Object.hasOwn(TASK_TOOLS, tool)
      ? TASK_TOOLS[tool]
      : undefined;
  const taskRef = typeof task === 'string' ? task.trim() : '';
  return kind && taskRef ? { tool: kind, taskRef } : null;
}

/** The scalar values of an object, so that no nested payload is kept. */
function scalarsOf(value: unknown): Entry | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(value as Entry).filter(
      ([, item]) =>
        item === null || ['string', 'number', 'boolean'].includes(typeof item),
    ),
  );
}

/** The strings of a list; anything else in it is dropped. */
function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined;
}

/**
 * The per-model map of an external result, as the adapter wrote it. Each model
 * keeps its scalar facts only: provider, cost basis, canonical model, and the
 * token counts and the cost of its own cumulative total.
 */
function modelMapOf(value: unknown): Record<string, Entry> | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(value as Entry).map(([model, facts]) => [
      model,
      scalarsOf(facts) ?? {},
    ]),
  );
}

/**
 * The external Claude's facts for one invocation. Identity and billing are
 * kept as the adapter wrote them. Totals are kept under `cumulativeTotals`,
 * because a resumed native session repeats earlier calls in them. Only
 * `billing.deltaApiEquivalentUsd` is this invocation's amount.
 */
function delegateFacts(details: Entry, billing: Entry | undefined): Entry {
  const modelUsage = modelMapOf(details.modelUsage);
  return definedOnly({
    invocationId: details.invocationId,
    claudeSessionId: details.claudeSessionId,
    ompSessionId: details.ompSessionId,
    intent:
      typeof details.intent === 'string'
        ? details.intent.slice(0, PROMPT_LIMIT)
        : undefined,
    status: details.status,
    requestedModel: details.requestedModel,
    canonicalModel: details.canonicalModel,
    actualModels: stringList(details.actualModels),
    modelSelection: details.modelSelection,
    resumed: details.resumed,
    billing: definedOnly({
      mode: billing?.mode,
      costBasis: billing?.costBasis,
      deltaApiEquivalentUsd: billing?.deltaApiEquivalentUsd,
      cumulative: billing?.cumulative,
    }),
    cumulativeTotals: definedOnly({
      apiEquivalentUsd: billing?.apiEquivalentUsd,
      usage: scalarsOf(details.usage),
      modelUsage,
    }),
  });
}

/**
 * The model that actually answered, as the adapter reports it. The canonical
 * model beats the requested alias; the requested alias is the last resort.
 */
function delegateModel(details: Entry): string | null {
  const modelUsage = modelMapOf(details.modelUsage) ?? {};
  for (const facts of Object.values(modelUsage)) {
    const canonical = stringOf(facts.canonicalModel);
    if (canonical) {
      return canonical;
    }
  }
  return (
    stringOf(details.canonicalModel) ??
    stringList(details.actualModels)?.[0] ??
    stringOf(details.requestedModel) ??
    null
  );
}

/**
 * The call that an entry records, or null for an entry that records none. An
 * assistant message is a request. An auxiliary `model_usage` is a request too.
 * A `claude_delegate` tool result is the external Claude's delta for one
 * invocation, which is counted once and never with its own breakdown.
 */
function usageFrom(entry: Entry, at: Date | null): SessionUsageCall | null {
  const message = entry.message as Entry | undefined;
  const usage = (message?.usage ?? entry.usage) as Entry | undefined;
  const details = message?.details as Entry | undefined;
  const isDelegate = details?.kind === 'claude-delegate';
  const isAuxiliary = entry.type === 'model_usage';
  if (!isDelegate && !isAuxiliary && message?.role !== 'assistant') {
    return null;
  }

  const responseId =
    stringOf(message?.responseId) ?? stringOf(entry.responseId);
  const invocationId = stringOf(details?.invocationId);
  const billing = details?.billing as Entry | undefined;
  const modelUsage = entry.modelUsage as Entry | undefined;

  const provider =
    stringOf(usage?.provider) ??
    stringOf(message?.provider) ??
    stringOf(entry.provider) ??
    stringOf(details?.provider);
  const explicitBasis =
    stringOf(usage?.costBasis) ?? stringOf(modelUsage?.costBasis);

  // Tool results of a delegate carry the external delta; any other call carries
  // its own amount. A missing amount stays missing.
  const cost = isDelegate
    ? (finite(billing?.deltaApiEquivalentUsd) ?? null)
    : (costOf(usage) ?? finite(modelUsage?.cost) ?? null);

  const billingMode: SessionUsageCall['billingMode'] =
    billing?.mode === 'subscription' ||
    (provider !== undefined && SUBSCRIPTION_PROVIDERS[provider] === true)
      ? 'subscription'
      : provider
        ? 'metered'
        : 'unknown';
  const costBasis: SessionUsageCall['costBasis'] =
    cost === null
      ? 'unknown'
      : isDelegate || explicitBasis === 'list'
        ? 'list'
        : explicitBasis === 'provider_reported'
          ? 'provider_reported'
          : 'harness_estimate';

  // A mirror of an assistant request shares its response id, so it is one call.
  const id =
    isDelegate && invocationId
      ? `delegate:${invocationId}`
      : responseId
        ? `response:${responseId}`
        : entryKeyOf(entry, at);

  const provenance: Record<string, unknown> = definedOnly({
    responseId,
    provider,
    api: stringOf(usage?.api) ?? stringOf(message?.api) ?? stringOf(entry.api),
    auxPurpose: isAuxiliary ? stringOf(entry.purpose) : undefined,
  });
  if (isDelegate && details) {
    provenance.delegate = delegateFacts(details, billing);
  }

  const modelId = isDelegate
    ? delegateModel(details ?? {})
    : (stringOf(message?.model) ?? stringOf(entry.model) ?? null);

  return {
    id,
    at,
    modelId,
    purpose: isDelegate
      ? 'claude_delegate'
      : isAuxiliary
        ? 'auxiliary'
        : 'assistant',
    costUsd: cost,
    billingMode,
    costBasis,
    provenance,
    ...(finite(usage?.input) !== undefined
      ? { inputTokens: finite(usage?.input) }
      : {}),
    ...(finite(usage?.output) !== undefined
      ? { outputTokens: finite(usage?.output) }
      : {}),
    ...(finite(usage?.cacheRead) !== undefined
      ? { cacheReadTokens: finite(usage?.cacheRead) }
      : {}),
    ...(finite(usage?.cacheWrite) !== undefined
      ? { cacheWriteTokens: finite(usage?.cacheWrite) }
      : {}),
  };
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
  const tasks: SessionTask[] = [];
  const calls = new Map<string, SessionUsageCall>();
  let lastAt: Date | null = null;

  for (const raw of entries) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const entry = raw as Entry;
    const stamp = entryTime(entry);
    const at = stamp ?? lastAt ?? new Date(0);
    if (!lastAt || at > lastAt) {
      lastAt = at;
    }

    const call = usageFrom(entry, stamp);
    if (call) {
      // A call that the file records twice (an assistant message and its
      // auxiliary mirror) is one call; an assistant record wins over a mirror.
      const existing = calls.get(call.id);
      if (
        !existing ||
        (existing.purpose === 'auxiliary' && call.purpose === 'assistant')
      ) {
        calls.set(call.id, call);
      }
    }

    const events: Entry[] = [];
    const message = entry.message as Entry | undefined;
    const key = entryKeyOf(entry, stamp);
    let stepIndex = 0;
    const stepKey = () => `${key}#${stepIndex++}`;

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
            key: stepKey(),
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
        blocks.forEach((block: unknown, index) => {
          const part = (block ?? {}) as Entry;
          if (part.type === 'toolCall') {
            events.push({
              type: 'tool_execution_start',
              toolName: part.name,
              toolCallId: part.id,
              args: part.arguments,
            });
          }
          const signal = taskSignalOf(block);
          if (signal) {
            tasks.push({
              key: `${key}#${index}`,
              at,
              tool: signal.tool,
              taskRef: signal.taskRef,
            });
          }
        });
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
        steps.push({ ...step, at, key: stepKey() });
      }
    }
  }

  const result = reader.result();
  const list = [...calls.values()];
  const costUsd = list.reduce((sum, call) => sum + (call.costUsd ?? 0), 0);
  return {
    steps,
    costUsd,
    turns: result.iterations,
    modelId: result.modelId,
    calls: list,
    tasks,
    lastAt,
  };
}

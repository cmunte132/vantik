/**
 * Soft delegation routing for omp: a cached read of the Codex subscription's
 * local pressure, a short policy block appended to the system prompt, and a
 * metadata-only record of what each delegation reported and what the primary
 * assessed about it.
 *
 * It is advisory. It never blocks a call, never overrides a model the user
 * named, and never reads a credential, calls a provider, or polls quota. The
 * only upstream-looking read is `usage.history`, which is local native history.
 *
 * Imports Node's built-ins only and uses structural types for omp's API, so it
 * bundles with nothing else, the same way `claude-delegate-extension` does.
 */

export const OUTCOME_ENTRY = 'vantik.delegation.outcome';
export const STATUS_KEY = 'vantik-quota';
/** First line of the appended policy block, so a repeated turn replaces it. */
export const ROUTING_MARK = '[vantik-delegation-routing]';

/** A native row older than this is stale, and its window is unknown. */
export const FRESH_MS = 15 * 60 * 1000;
/** Used fraction at or above which a window is `conserve`. */
export const CONSERVE_AT = 0.8;

const CACHE_MS = 60 * 1000;
const CODEX = 'openai-codex';
const MAX_EVIDENCE = 10;
const MAX_SEEN = 500;
const MAX_USAGE_KEYS = 20;

export const OUTCOMES = [
  'verified',
  'needs_rework',
  'failed',
  'escalated',
] as const;
export type PrimaryOutcome = (typeof OUTCOMES)[number];

export type PressureState = 'normal' | 'conserve' | 'exhausted' | 'unknown';
export type WindowName = 'primary' | 'secondary';

export interface WindowSummary {
  state: PressureState;
  usedFraction?: number;
  resetsAt?: number;
  ageMs?: number;
}

/** One account, labelled by position only: the account key is never reported. */
export interface AccountSummary {
  label: string;
  state: PressureState;
  windows: Record<WindowName, WindowSummary>;
}

export interface QuotaSnapshot {
  /** Unknown unless there is one account, or every account agrees. */
  state: PressureState;
  computedAt: number;
  accounts: AccountSummary[];
}

/** The fields of a native history row this reads. Anything else is ignored. */
export interface HistoryRow {
  recordedAt: number;
  accountKey: string;
  limitId: string;
  usedFraction?: number;
  status?: string;
  resetsAt?: number;
}

/**
 * What one delegation reported, and what the primary assessed. `source`
 * says which: `native` rows only ever carry `not-assessed`, because a
 * completed run is not an accepted one.
 */
export interface OutcomeRecord {
  source: 'native' | 'primary';
  recordedAt: number;
  toolName: string;
  toolCallId: string;
  invocationId?: string;
  agent?: string;
  intent?: string;
  requestedModel?: string;
  requestedRole?: string;
  modelSelection?: 'explicit' | 'default';
  resolvedModel?: string;
  resolvedModels?: string[];
  resolvedModelIdentity?: string;
  resolvedThinkingLevel?: string;
  resolvedModelIsFallback?: boolean;
  route?: string;
  reportedStatus?: string;
  isError?: boolean;
  usage?: Record<string, number>;
  assessment: 'not-assessed' | PrimaryOutcome;
  reason?: string;
  /** References the primary checked, such as paths or test names. Never content. */
  evidence?: string[];
}

export interface RoutingContext {
  hasUI?: boolean;
  modelRegistry?: {
    authStorage?: {
      usage?: { history?(query: { provider: string }): unknown };
    };
  };
  ui?: {
    setStatus?(key: string, text: string | undefined): void;
    notify?(message: string, level?: 'info' | 'warning' | 'error'): void;
  };
}

export type RoutingHandler = (event: unknown, ctx: RoutingContext) => unknown;

/** The slice of omp's extension API this uses, so nothing is imported at run time. */
export interface RoutingPi {
  on?(event: string, handler: RoutingHandler): void;
  registerTool?(tool: RoutingTool): void;
  registerCommand?(
    name: string,
    command: {
      description: string;
      handler(args: string, ctx: RoutingContext): Promise<void> | void;
    },
  ): void;
  appendEntry?(customType: string, data: OutcomeRecord): void;
}

export interface RoutingTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  loadMode?: 'essential';
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: RoutingContext,
  ): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    details: Record<string, unknown>;
  }>;
}

export interface RoutingOptions {
  /** Epoch milliseconds. Injectable so boundary tests are deterministic. */
  now?: () => number;
  cacheMs?: number;
}

/**
 * Turns native history rows into a snapshot. Only the two base Codex windows
 * count, so Spark and other feature meters never enter the picture.
 */
export function summarizeQuota(
  rows: readonly unknown[],
  at: number,
): QuotaSnapshot {
  const accounts = new Map<string, Partial<Record<WindowName, HistoryRow>>>();
  for (const raw of rows) {
    const row = asRow(raw);
    const name = row ? windowOf(row.limitId) : null;
    if (!row || !name) {
      continue;
    }
    const slot = accounts.get(row.accountKey) ?? {};
    const latest = slot[name];
    if (!latest || row.recordedAt >= latest.recordedAt) {
      slot[name] = row;
    }
    accounts.set(row.accountKey, slot);
  }

  const summaries = [...accounts.values()].map((slot, index) => {
    const windows = {
      primary: evaluateWindow(slot.primary, at),
      secondary: evaluateWindow(slot.secondary, at),
    };
    return {
      label: `account ${index + 1}`,
      state: accountState(windows),
      windows,
    };
  });

  return {
    state: overallState(summaries),
    computedAt: at,
    accounts: summaries,
  };
}

/**
 * Reads the local native history for Codex and caches the snapshot for a short
 * time. A missing, throwing, or malformed history is unknown, never normal.
 */
export function createQuotaCache(now: () => number, ttlMs: number = CACHE_MS) {
  let cached: QuotaSnapshot | null = null;
  return {
    async current(
      ctx: RoutingContext | undefined,
      force = false,
    ): Promise<QuotaSnapshot> {
      if (cached && !force) {
        const age = now() - cached.computedAt;
        if (age >= 0 && age < ttlMs) {
          return cached;
        }
      }
      const at = now();
      const rows = await readHistory(ctx);
      cached = summarizeQuota(rows ?? [], at);
      return cached;
    },
  };
}

/**
 * The system prompt with the routing block appended. Existing blocks are
 * kept as they are, and a block from an earlier turn is replaced, not stacked.
 */
export function withRoutingPolicy(
  systemPrompt: readonly unknown[],
  state: PressureState,
): unknown[] {
  const kept = systemPrompt.filter(
    (block) => !(typeof block === 'string' && block.startsWith(ROUTING_MARK)),
  );
  return [...kept, routingBlock(state)];
}

/** Static policy plus one coarse pressure line. It changes only with the bucket. */
export function routingBlock(state: PressureState): string {
  return [
    ROUTING_MARK,
    'Delegation routing (advisory, not a budget control):',
    '- Choose each assignment’s intent and model role yourself. Bounded execution suits an economical worker role. Ambiguous diagnosis, planning, and consequential review need a strong role.',
    '- A model the user named explicitly always wins. Never swap or downgrade it.',
    '- When only the open reasoning needs a strong model, escalate that piece, then return the execution to an economical worker.',
    '- claude_delegate runs the official Claude CLI on the user’s Claude subscription. It is a tool, not a model, and its default model is claude-haiku-5-5.',
    `- Codex subscription pressure: ${state}. ${PRESSURE_HINT[state]}`,
    '- Use already-authorized cash routes within the user’s budget. Subscription list-price estimates are neither cash spend nor cash savings.',
    '- A finished run is not an accepted one. After you check a delegation, record the result with delegation_outcome.',
  ].join('\n');
}

const PRESSURE_HINT: Record<PressureState, string> = {
  normal: 'Use the normal routes.',
  conserve:
    'Prefer other available routes for bounded execution, and keep strong roles for the work that needs them.',
  exhausted:
    'Send no new work to openai-codex routes until the window resets, unless the user says otherwise.',
  unknown:
    'Unknown is not unlimited. Treat bounded work as conserve, and do not assume capacity.',
};

/** Short advisory for a before_subagent_spawn note. Never a model choice. */
export function spawnNote(state: PressureState): string | undefined {
  if (state === 'normal') {
    return undefined;
  }
  return `Codex subscription pressure is ${state}. ${PRESSURE_HINT[state]}`;
}

/**
 * The native `task` and `claude_delegate` results, as metadata rows. Every row
 * says `not-assessed`: the native run finishing is not the work being accepted.
 */
export function nativeOutcomeRecords(
  event: Record<string, unknown>,
  at: number,
): OutcomeRecord[] {
  const toolName = event.toolName;
  if (toolName !== 'task' && toolName !== 'claude_delegate') {
    return [];
  }
  const base: OutcomeRecord = {
    source: 'native',
    recordedAt: at,
    toolName,
    toolCallId: text(event.toolCallId) ?? '',
    isError: event.isError === true,
    assessment: 'not-assessed',
  };
  const details = isRecord(event.details) ? event.details : {};

  if (toolName === 'claude_delegate') {
    return [delegateRecord(base, details)];
  }

  const results = Array.isArray(details.results)
    ? details.results.filter(isRecord)
    : [];
  if (results.length === 0) {
    return [base];
  }
  return results.map((result) => taskRecord(base, result));
}

/** The record for one explicit `delegation_outcome` call. */
export function explicitOutcomeRecord(
  params: Record<string, unknown>,
  toolCallId: string,
  at: number,
): OutcomeRecord {
  const parsed = parseOutcomeParams(params);
  return {
    source: 'primary',
    recordedAt: at,
    toolName: 'delegation_outcome',
    toolCallId,
    invocationId: parsed.invocationId,
    assessment: parsed.outcome,
    reason: parsed.reason,
    evidence: parsed.evidence,
  };
}

/**
 * Registers the routing hooks, the `delegation_outcome` tool, and the
 * `/routing-status` command. Call it once per omp session.
 */
export function registerDelegationRouting(
  pi: RoutingPi,
  options: RoutingOptions = {},
): void {
  const now = options.now ?? (() => Date.now());
  const cache = createQuotaCache(now, options.cacheMs);
  const seen = new Set<string>();

  /** Appends a record once per key. A repeated callback is a no-op. */
  const append = (key: string, record: OutcomeRecord): boolean => {
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    if (seen.size > MAX_SEEN) {
      seen.delete(seen.values().next().value as string);
    }
    pi.appendEntry?.(OUTCOME_ENTRY, record);
    return true;
  };

  pi.on?.('session_start', async (_event, ctx) => {
    setStatus(ctx, await cache.current(ctx, true));
  });

  pi.on?.('before_agent_start', async (event, ctx) => {
    const snapshot = await cache.current(ctx);
    setStatus(ctx, snapshot);
    const systemPrompt = isRecord(event) ? event.systemPrompt : undefined;
    const blocks = Array.isArray(systemPrompt)
      ? systemPrompt
      : typeof systemPrompt === 'string'
        ? [systemPrompt]
        : [];
    return { systemPrompt: withRoutingPolicy(blocks, snapshot.state) };
  });

  pi.on?.('before_subagent_spawn', async (_event, ctx) => {
    const note = spawnNote((await cache.current(ctx)).state);
    // Only an explanatory note. Never a model, so an explicit choice stands.
    return note ? { note } : undefined;
  });

  pi.on?.('tool_result', (event) => {
    if (!isRecord(event)) {
      return;
    }
    const records = nativeOutcomeRecords(event, now());
    records.forEach((record, index) =>
      append(`${record.toolName}:${record.toolCallId}:${index}`, record),
    );
  });

  pi.registerTool?.({
    name: 'delegation_outcome',
    label: 'Delegation outcome',
    description:
      'Record your assessment of a delegated run: its invocationId, the outcome (verified, needs_rework, failed, or escalated), the reason, and optional evidence references. A finished run is not an accepted one, so assess it after you check it. This records your judgment. It does not verify the work.',
    promptSnippet:
      'delegation_outcome: record whether a delegated run was verified, needs rework, failed, or needs a strong model',
    loadMode: 'essential',
    parameters: {
      type: 'object',
      properties: {
        invocationId: {
          type: 'string',
          description:
            'The invocationId of the claude_delegate run, or the toolCallId of the task call.',
        },
        outcome: {
          type: 'string',
          enum: [...OUTCOMES],
          description:
            'verified: you checked the work. needs_rework: fixable here. failed: it did not do the job. escalated: the open reasoning needs a strong role.',
        },
        reason: {
          type: 'string',
          description: 'Why, in a sentence or two.',
        },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          maxItems: MAX_EVIDENCE,
          description:
            'Short references you checked, such as file paths, test names, or commands. Not the content itself.',
        },
      },
      required: ['invocationId', 'outcome', 'reason'],
      additionalProperties: false,
    },
    execute: async (toolCallId, params) => {
      const record = explicitOutcomeRecord(params, toolCallId, now());
      const recorded = append(`delegation_outcome:${toolCallId}`, record);
      const evidence = record.evidence ?? [];
      const note = recorded
        ? `Recorded ${record.assessment} for ${record.invocationId}`
        : `Already recorded for this call; ${record.invocationId} unchanged`;
      return {
        content: [
          {
            type: 'text',
            text: `${note}. This is your assessment with ${evidence.length} evidence reference(s). It does not verify the work itself.`,
          },
        ],
        details: { recorded, assessment: record.assessment },
      };
    },
  });

  pi.registerCommand?.('routing-status', {
    description:
      'Show the Codex subscription pressure, its freshness and reset times, and the soft routing policy. Reads local history only.',
    handler: async (_args, ctx) => {
      const snapshot = await cache.current(ctx, true);
      setStatus(ctx, snapshot);
      show(ctx, describeQuota(snapshot, now()));
    },
  });
}

/** Lines for `/routing-status`. Accounts are anonymous, and no key is shown. */
export function describeQuota(snapshot: QuotaSnapshot, at: number): string[] {
  const freshest = freshestAgeMs(snapshot);
  const lines = [
    `Codex subscription pressure: ${snapshot.state}`,
    `Read ${formatDuration(at - snapshot.computedAt)} ago from local history. Newest window data: ${
      freshest === null ? 'none' : `${formatDuration(freshest)} old`
    } (fresh within ${formatDuration(FRESH_MS)}).`,
  ];
  const count = snapshot.accounts.length;
  if (count === 0) {
    lines.push('No Codex primary or secondary window in native history.');
  } else if (count > 1) {
    lines.push(
      `${count} accounts seen, so the overall state is unknown unless they agree. The native broker chooses the active one.`,
    );
  }
  for (const account of snapshot.accounts) {
    lines.push(
      `${account.label}: ${account.state}. primary ${describeWindow(account.windows.primary)}; secondary ${describeWindow(account.windows.secondary)}`,
    );
  }
  lines.push(
    `Soft policy: ${snapshot.state}. ${PRESSURE_HINT[snapshot.state]}`,
  );
  return lines;
}

function describeWindow(window: WindowSummary): string {
  const parts: string[] = [window.state];
  if (window.usedFraction !== undefined) {
    parts.push(`${Math.round(window.usedFraction * 100)}% used`);
  }
  if (window.resetsAt !== undefined) {
    parts.push(`resets ${new Date(window.resetsAt).toISOString()}`);
  }
  return parts.join(', ');
}

function evaluateWindow(
  row: HistoryRow | undefined,
  at: number,
): WindowSummary {
  if (!row) {
    return { state: 'unknown' };
  }
  const ageMs = at - row.recordedAt;
  const summary = {
    ageMs,
    usedFraction: row.usedFraction,
    resetsAt: row.resetsAt,
  };
  // Future rows and rows past the freshness window are not trusted.
  if (ageMs < 0 || ageMs > FRESH_MS) {
    return { ...summary, state: 'unknown' };
  }
  // An elapsed reset means the window has rolled over since the row was written.
  if (row.resetsAt !== undefined && row.resetsAt <= at) {
    return { ...summary, state: 'unknown' };
  }
  if (row.status === 'exhausted') {
    return { ...summary, state: 'exhausted' };
  }
  if (row.status === 'warning') {
    return { ...summary, state: 'conserve' };
  }
  if (row.status !== undefined && row.status !== 'ok') {
    return { ...summary, state: 'unknown' };
  }
  const fraction = row.usedFraction;
  // An unknown fraction is not zero.
  if (fraction === undefined || fraction < 0 || fraction > 1) {
    return { ...summary, state: 'unknown' };
  }
  return {
    ...summary,
    state: fraction >= CONSERVE_AT ? 'conserve' : 'normal',
  };
}

/** Both windows must be known and normal before an account is normal. */
function accountState(
  windows: Record<WindowName, WindowSummary>,
): PressureState {
  const states = [windows.primary.state, windows.secondary.state];
  if (states.includes('exhausted')) {
    return 'exhausted';
  }
  if (states.includes('conserve')) {
    return 'conserve';
  }
  if (states.every((state) => state === 'normal')) {
    return 'normal';
  }
  return 'unknown';
}

/**
 * One account, or several that agree, gives a state. Several that disagree
 * give unknown, because the active account is not known.
 */
function overallState(accounts: AccountSummary[]): PressureState {
  if (accounts.length === 0) {
    return 'unknown';
  }
  const first = accounts[0].state;
  return accounts.every((account) => account.state === first)
    ? first
    : 'unknown';
}

function freshestAgeMs(snapshot: QuotaSnapshot): number | null {
  const ages = snapshot.accounts.flatMap((account) =>
    Object.values(account.windows)
      .map((window) => window.ageMs)
      .filter((age): age is number => age !== undefined),
  );
  return ages.length === 0 ? null : Math.min(...ages);
}

function windowOf(limitId: string): WindowName | null {
  if (limitId === 'openai-codex:primary') {
    return 'primary';
  }
  if (limitId === 'openai-codex:secondary') {
    return 'secondary';
  }
  return null;
}

/** Narrows one raw row. A row without a usable timestamp or account is dropped. */
function asRow(value: unknown): HistoryRow | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.provider !== undefined && value.provider !== CODEX) {
    return null;
  }
  const { recordedAt, accountKey, limitId, usedFraction, status, resetsAt } =
    value;
  if (!isFiniteNumber(recordedAt)) {
    return null;
  }
  if (typeof accountKey !== 'string' || accountKey === '') {
    return null;
  }
  if (typeof limitId !== 'string') {
    return null;
  }
  return {
    recordedAt,
    accountKey,
    limitId,
    usedFraction: isFiniteNumber(usedFraction) ? usedFraction : undefined,
    status: typeof status === 'string' ? status : undefined,
    resetsAt: isFiniteNumber(resetsAt) ? resetsAt : undefined,
  };
}

async function readHistory(
  ctx: RoutingContext | undefined,
): Promise<unknown[] | null> {
  try {
    const usage = ctx?.modelRegistry?.authStorage?.usage;
    if (!usage || typeof usage.history !== 'function') {
      return null;
    }
    const rows = await usage.history({ provider: CODEX });
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

function delegateRecord(
  base: OutcomeRecord,
  details: Record<string, unknown>,
): OutcomeRecord {
  const selection = details.modelSelection;
  return {
    ...base,
    invocationId: text(details.invocationId),
    intent: text(details.intent),
    requestedModel: text(details.requestedModel),
    modelSelection:
      selection === 'explicit' || selection === 'default'
        ? selection
        : undefined,
    resolvedModels: strings(details.actualModels, 5),
    route: 'claude-cli',
    reportedStatus: text(details.status),
    usage: numbers(details.usage),
  };
}

function taskRecord(
  base: OutcomeRecord,
  result: Record<string, unknown>,
): OutcomeRecord {
  return {
    ...base,
    agent: text(result.agent),
    requestedModel: text(result.modelOverride),
    requestedRole: text(result.modelRole),
    resolvedModel: text(result.resolvedModel),
    resolvedModelIdentity: text(result.resolvedModelIdentity),
    resolvedThinkingLevel: text(result.resolvedThinkingLevel),
    resolvedModelIsFallback:
      typeof result.resolvedModelIsFallback === 'boolean'
        ? result.resolvedModelIsFallback
        : undefined,
    route: text(result.resolvedModelRoute),
    reportedStatus: text(result.status),
    usage: numbers(result.usage),
  };
}

function parseOutcomeParams(params: Record<string, unknown>): {
  invocationId: string;
  outcome: PrimaryOutcome;
  reason: string;
  evidence: string[];
} {
  const invocationId = text(params.invocationId);
  if (!invocationId) {
    throw new Error('invocationId is required');
  }
  const outcome = OUTCOMES.find((known) => known === params.outcome);
  if (!outcome) {
    throw new Error(`outcome must be one of ${OUTCOMES.join(', ')}`);
  }
  const reason = text(params.reason, 500);
  if (!reason) {
    throw new Error('reason is required');
  }
  const evidence = Array.isArray(params.evidence)
    ? params.evidence
        .map((item) => text(item))
        .filter((item): item is string => !!item)
    : [];
  if (evidence.length > MAX_EVIDENCE) {
    throw new Error(`at most ${MAX_EVIDENCE} evidence references`);
  }
  return { invocationId, outcome, reason, evidence };
}

function setStatus(ctx: RoutingContext | undefined, snapshot: QuotaSnapshot) {
  const count = snapshot.accounts.length;
  const suffix = count > 1 ? ` (${count} accounts)` : '';
  ctx?.ui?.setStatus?.(STATUS_KEY, `Codex quota: ${snapshot.state}${suffix}`);
}

/** Shows lines to the person when omp has a UI, and to stderr otherwise. */
function show(ctx: RoutingContext | undefined, lines: string[]) {
  const message = lines.join('\n');
  if (ctx?.hasUI && ctx.ui?.notify) {
    ctx.ui.notify(message, 'info');
    return;
  }
  // stdout carries omp's event stream, so a line for a person goes to stderr.
  process.stderr.write(`${message}\n`);
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A trimmed, non-empty string, capped in length. Anything else is absent. */
function text(value: unknown, max = 200): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed.slice(0, max);
}

function strings(value: unknown, max: number): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value
    .map((item) => text(item))
    .filter((item): item is string => !!item)
    .slice(0, max);
  return out.length > 0 ? out : undefined;
}

/** The finite numeric fields of a usage object. Nested values are dropped. */
function numbers(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: Record<string, number> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_USAGE_KEYS)) {
    if (isFiniteNumber(item)) {
      out[key] = item;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

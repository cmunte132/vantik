/**
 * The Vantik extension for Pi, loaded into every hosted agent run.
 *
 * The host writes this file into the guest beside the run's prompt, outside
 * the checkout, and starts Pi with `--no-extensions -e <this file>`, so it is
 * the only extension that loads — never one from the repository.
 *
 * It is help, not a boundary. It runs inside Pi, inside the guest, where the
 * agent has a shell; a prompt-injected agent can edit or bypass it. Everything
 * that must hold is enforced on the host: the egress allowlist, the push
 * (see sandbox/push-scope.ts), the deadline, the budget. What this adds is
 * the same rules said to the agent at the moment it is about to break one,
 * with what to do instead, so an honest agent does not waste a pass learning
 * them from a failure — and a record of every time it happened, because a
 * run that keeps hitting them is either lost or being steered.
 *
 * It also times each model call from the moment the request leaves, which the
 * host's spans cannot see, and reports it as a content-free record.
 *
 * Self-contained on purpose: the guest has no node_modules of ours, so this
 * file imports nothing at run time but Node's own modules and its sibling
 * `vantik-lsp`, which the host seeds beside it. The rules are exported so the
 * server's tests exercise exactly what the guest runs.
 */
/* eslint-disable turbo/no-undeclared-env-vars -- VANTIK_POLICY is set in the guest by the host, not read by the server. */
import { appendFileSync, readFileSync } from 'node:fs';

import { registerCodeTools } from './vantik-lsp';

/** What the host tells the extension about this run, as JSON. */
export interface GuardrailPolicy {
  /** The checkout, which is Pi's working directory. */
  repoRoot: string;
  /** The issue's modules' prefixes in this repository; empty is all of it. */
  pathPrefixes: string[];
  /** The repository's own checks, as the host will run them. */
  checks: string[];
  /** Hosts the sandbox can reach besides the model provider. */
  reachableHosts: string[];
  /** The run's context pack, which the Vantik tools read. */
  contextPath?: string;
  /** Where the Vantik tools queue what the agent writes to Vantik. */
  outboxPath?: string;
  /** The most output tokens one model call may ask for. */
  maxOutputTokens?: number;
}

/**
 * One thing the agent asked to write to Vantik, as a line of the outbox.
 *
 * The guest holds no Vantik credential, so the tools only queue. The host
 * reads the outbox after each pass, checks every line against the run (see
 * run-outbox.ts) and applies what passes as the run's agent. The agent can
 * write this file with its shell as easily as with the tools, which is why
 * the checks are on the host and not here.
 */
export type OutboxItem =
  | { v: 1; type: 'note'; body: string }
  | { v: 1; type: 'criterion'; id: string; evidence: string }
  | {
      v: 1;
      type: 'remember';
      content: string;
      kind?: 'FACT' | 'DECISION' | 'CONVENTION' | 'GOTCHA';
      citations?: Array<{ path: string; lines?: string }>;
    };

export interface Verdict {
  rule: 'no-git' | 'egress' | 'scope' | 'ci' | 'destructive';
  reason: string;
}

/**
 * How the host recognises a guardrail in Pi's event stream.
 *
 * Pi keeps its stdout for its own JSON events and sends anything an extension
 * prints to stderr, so a record of our own would not reach the stream the host
 * reads live. The hits are already in that stream, though: a blocked call ends
 * as a failed `tool_execution_end` whose text is the reason, and the reminder
 * is a user message. Both start with a fixed tag, which the host parses
 * (`guardrailOf` in executors/pi-events.ts). The agent could print the same
 * tag itself; the host treats the count as a signal, never as a fact.
 */
export const BLOCKED_TAG = 'Blocked by Vantik';
export const REMINDER_TAG = 'Vantik: before you finish';

/**
 * The record the extension appends for each model call, read back by the host
 * from Pi's `entry_appended` events (`modelCallOf` in executors/pi-events.ts).
 *
 * Timings only: no prompt, no message, no header. Durations are measured from
 * the moment Pi sent the request, which the host cannot see — its own chat span
 * starts when the first byte of the answer reaches the stream.
 */
export const MODEL_CALL_ENTRY = 'vantik.model_call';

export interface ModelCallRecord {
  v: 1;
  /** HTTP status of the provider's response, when one arrived. */
  status?: number;
  /** Request sent to response headers received. */
  responseMs?: number;
  /** Request sent to the first streamed update. */
  ttftMs?: number;
  /** Request sent to the message settling. */
  durationMs: number;
}

/** The text a blocked call fails with. */
export function blockedReason(verdict: Verdict): string {
  return `${BLOCKED_TAG} (${verdict.rule}): ${verdict.reason}`;
}

const CI_PATHS: RegExp[] = [
  /^\.github\/(workflows|actions)\//,
  /^\.(forgejo|gitea)\/workflows\//,
  /^\.gitlab-ci\.yml$/,
  /^\.gitlab\/ci\//,
  /^\.circleci\//,
  /^\.buildkite\//,
  /^\.woodpecker(\.ya?ml|\/)/,
  /^\.drone\.ya?ml$/,
  /^Jenkinsfile$/,
];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

const TEST_COMMAND =
  /(^|\s|\/)(jest|vitest|pytest|rspec|mocha|ava|phpunit|tsc|eslint|ruff|mypy)(\s|$)|\b(test|tests|lint|typecheck|check)\b/i;

/**
 * Whether a tool call should be refused, and why.
 *
 * Pure, so the server's tests run the guest's rules without a guest.
 */
export function checkToolCall(
  toolName: string,
  input: Record<string, unknown>,
  policy: GuardrailPolicy,
): Verdict | null {
  if (toolName === 'bash') {
    return checkCommand(String(input.command ?? ''), policy);
  }

  if (toolName === 'write' || toolName === 'edit') {
    const path = input.path ?? input.file_path;
    return typeof path === 'string' ? checkWrite(path, policy) : null;
  }

  return null;
}

function checkCommand(
  command: string,
  policy: GuardrailPolicy,
): Verdict | null {
  if (/(^|[\s;&|(`$])git(\s|$)/.test(command)) {
    return {
      rule: 'no-git',
      reason:
        'This checkout has no .git, so git commands fail here. ' +
        'You do not need them: the host commits and pushes your work when you finish. ' +
        'To see what a file looked like, read it; to see what you changed, re-read what you edited.',
    };
  }

  if (
    /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(\/|\/workspace\/?|\/workspace\/repo\/?|\.\/?|~\/?|\*)(\s|;|&|$)/.test(
      command,
    )
  ) {
    return {
      rule: 'destructive',
      reason:
        'That deletes the whole checkout (or more). Delete the specific files you mean.',
    };
  }

  const reachable = new Set(policy.reachableHosts.map((h) => h.toLowerCase()));
  for (const host of hostsIn(command)) {
    if (!LOCAL_HOSTS.has(host) && !reachable.has(host)) {
      return {
        rule: 'egress',
        reason:
          `${host} is not reachable from this sandbox, so this would hang and fail. ` +
          `Reachable: the model provider${policy.reachableHosts.length ? `, ${policy.reachableHosts.join(', ')}` : ''}. ` +
          'Work with what is installed, and if you truly need something else, say so in your summary.',
      };
    }
  }

  return null;
}

/** Hostnames named by URLs and scp-style remotes in a command. */
export function hostsIn(command: string): string[] {
  const hosts = new Set<string>();

  for (const match of command.matchAll(
    /\b(?:https?|ftp|ssh|git|wss?):\/\/(?:[^/\s'"@]+@)?(\[[^\]]+\]|[^/\s:'"?#]+)/gi,
  )) {
    hosts.add(match[1].replace(/^\[|\]$/g, '').toLowerCase());
  }

  for (const match of command.matchAll(/\b[\w.-]+@([\w-]+(?:\.[\w-]+)+):/g)) {
    hosts.add(match[1].toLowerCase());
  }

  return [...hosts];
}

function checkWrite(path: string, policy: GuardrailPolicy): Verdict | null {
  const relative = repoRelative(path, policy.repoRoot);

  // Outside the checkout — /tmp, a scratch file — is not part of the work and
  // never reaches the push.
  if (relative === null) {
    return null;
  }

  if (CI_PATHS.some((pattern) => pattern.test(relative))) {
    return {
      rule: 'ci',
      reason:
        `${relative} is CI configuration, which an agent run never changes; ` +
        'the host refuses to push it. Leave CI as it is and mention the change you wanted in your summary.',
    };
  }

  const prefixes = policy.pathPrefixes
    .map((prefix) => prefix.replace(/^\.?\/+/, ''))
    .filter(Boolean);

  if (
    prefixes.length &&
    !prefixes.some((prefix) => relative.startsWith(prefix))
  ) {
    return {
      rule: 'scope',
      reason:
        `${relative} is outside this issue's modules (${prefixes.join(', ')}). ` +
        'The host refuses to push changes outside them, which would lose the whole run. ' +
        'Make the change inside those paths, or say in your summary what else needs changing.',
    };
  }

  return null;
}

/** The path relative to the checkout, or null when it is outside it. */
export function repoRelative(path: string, repoRoot: string): string | null {
  const root = repoRoot.replace(/\/+$/, '');
  const absolute = path.startsWith('/') ? path : `${root}/${path}`;
  const parts: string[] = [];

  for (const part of absolute.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }

  const normalised = `/${parts.join('/')}`;

  if (normalised === root) {
    return '';
  }
  return normalised.startsWith(`${root}/`)
    ? normalised.slice(root.length + 1)
    : null;
}

/** Whether a command runs one of the repository's checks, or looks like one. */
export function isCheckCommand(
  command: string,
  policy: GuardrailPolicy,
): boolean {
  return (
    policy.checks.some((check) => check && command.includes(check)) ||
    TEST_COMMAND.test(command)
  );
}

/** What the agent is told when it is about to stop without checking. */
export function checkReminder(policy: GuardrailPolicy): string {
  return [
    `${REMINDER_TAG}: you changed files but have not run any of this repository’s checks.`,
    `Run ${policy.checks.map((check) => `\`${check}\``).join(', ')} now, fix what fails,`,
    'and then finish with your summary. The host runs the same checks after you, and a failure there sends the work back.',
  ].join(' ');
}

// ------------------------------------------------------------------ wiring

/** The slice of Pi's ExtensionAPI this uses, so nothing is imported at run time. */
export interface PiApi {
  // The handlers below narrow the event to what they read.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (event: any, ctx: unknown) => unknown): void;
  sendUserMessage(
    content: string,
    options?: { deliverAs?: 'steer' | 'followUp' },
  ): void;
  appendEntry(customType: string, data?: unknown): void;
  registerTool?(tool: PiTool): void;
}

/** The slice of Pi's ToolDefinition the Vantik tools use. */
export interface PiTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  /**
   * omp (oh-my-pi) shows the model only the tools an extension marks
   * `essential`; Pi ignores the field. Set for every tool by `vantik` below.
   */
  loadMode?: 'essential';
  /** JSON Schema. Pi validates plain JSON Schema as well as TypeBox. */
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
  ): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    details: unknown;
  }>;
}

function readPolicy(): GuardrailPolicy | null {
  const path = process.env.VANTIK_POLICY;
  if (!path) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      readFileSync(path, 'utf8'),
    ) as Partial<GuardrailPolicy>;

    return {
      repoRoot: String(parsed.repoRoot ?? process.cwd()),
      pathPrefixes: Array.isArray(parsed.pathPrefixes)
        ? parsed.pathPrefixes.map(String)
        : [],
      checks: Array.isArray(parsed.checks) ? parsed.checks.map(String) : [],
      reachableHosts: Array.isArray(parsed.reachableHosts)
        ? parsed.reachableHosts.map(String)
        : [],
      ...(typeof parsed.contextPath === 'string'
        ? { contextPath: parsed.contextPath }
        : {}),
      ...(typeof parsed.outboxPath === 'string'
        ? { outboxPath: parsed.outboxPath }
        : {}),
      ...(typeof parsed.maxOutputTokens === 'number' &&
      Number.isInteger(parsed.maxOutputTokens) &&
      parsed.maxOutputTokens > 0
        ? { maxOutputTokens: parsed.maxOutputTokens }
        : {}),
    };
  } catch {
    return null;
  }
}

export default function vantik(host: PiApi) {
  // Without `loadMode: 'essential'` omp keeps extension tools away from the
  // model. Pi 0.82 ignores unknown fields on a tool, so one registration works
  // for both harnesses.
  const pi: PiApi = {
    ...host,
    on: host.on.bind(host),
    sendUserMessage: host.sendUserMessage.bind(host),
    appendEntry: host.appendEntry.bind(host),
    ...(host.registerTool
      ? {
          registerTool: (tool: PiTool) =>
            host.registerTool?.({ ...tool, loadMode: 'essential' }),
        }
      : {}),
  };
  capModelCalls(pi);
  reportModelCalls(pi);
  enforceGuardrails(pi);
  registerVantikTools(pi);
  registerCodeTools(pi, readPolicy()?.repoRoot ?? process.cwd());
}

/**
 * Lowers what each model call asks for in output tokens.
 *
 * Pi asks for the model's whole catalog maximum on every call — 128k for
 * Sonnet — and gateways reserve credit for all of it before answering, at
 * the output price. An account with less than that reservation left cannot
 * make a call at all, however little the call would have cost. An agent turn
 * never needs that much, so the cap here is generous for the work and small
 * for the reservation.
 *
 * Only ever lowers, and never below the call's thinking budget plus room to
 * answer: a provider rejects a ceiling under the thinking it was promised.
 * Cost control, not a boundary — the host's budget holds either way.
 */
export function capModelCalls(pi: PiApi) {
  const cap = readPolicy()?.maxOutputTokens;
  if (!cap) {
    return;
  }
  pi.on('before_provider_request', (event: { payload?: unknown }) =>
    capOutputTokens(event.payload, cap),
  );
}

/** Room to answer above a thinking budget. */
const ANSWER_ROOM = 4096;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;

/**
 * The payload with its output-token ceiling lowered to `cap`, or undefined
 * when there is nothing to lower. Knows each API Pi speaks: chat completions
 * (`max_tokens` or `max_completion_tokens`), responses (`max_output_tokens`),
 * Anthropic messages (`max_tokens`), Google (`generationConfig`) and Bedrock
 * (`inferenceConfig`).
 */
export function capOutputTokens(
  payload: unknown,
  cap: number,
): Record<string, unknown> | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const thinking = isRecord(payload.thinking) ? payload.thinking : {};
  const reasoning = isRecord(payload.reasoning) ? payload.reasoning : {};
  const generation = isRecord(payload.generationConfig)
    ? payload.generationConfig
    : undefined;
  const thinkingConfig = isRecord(generation?.thinkingConfig)
    ? generation.thinkingConfig
    : {};
  const bedrockThinking = isRecord(payload.additionalModelRequestFields)
    ? payload.additionalModelRequestFields.thinking
    : undefined;
  const budget = Math.max(
    count(thinking.budget_tokens) ?? 0,
    count(reasoning.max_tokens) ?? 0,
    count(thinkingConfig.thinkingBudget) ?? 0,
    count(isRecord(bedrockThinking) ? bedrockThinking.budget_tokens : 0) ?? 0,
  );
  const ceiling = Math.max(cap, budget ? budget + ANSWER_ROOM : 0);
  const lower = (value: unknown) => {
    const asked = count(value);
    return asked !== undefined && asked > ceiling ? ceiling : undefined;
  };

  let changed = false;
  const next: Record<string, unknown> = { ...payload };
  for (const field of [
    'max_tokens',
    'max_completion_tokens',
    'max_output_tokens',
  ]) {
    const lowered = lower(payload[field]);
    if (lowered !== undefined) {
      next[field] = lowered;
      changed = true;
    }
  }
  for (const [container, field] of [
    ['generationConfig', 'maxOutputTokens'],
    ['inferenceConfig', 'maxTokens'],
  ] as const) {
    const inner = payload[container];
    const lowered = isRecord(inner) ? lower(inner[field]) : undefined;
    if (isRecord(inner) && lowered !== undefined) {
      next[container] = { ...inner, [field]: lowered };
      changed = true;
    }
  }

  return changed ? next : undefined;
}

/**
 * Times each model call from the moment Pi sends it. Runs with or without a
 * policy: the host's monitoring should not depend on the guardrails' input.
 *
 * Pi runs extension handlers before it writes the event they handle, so the
 * record lands in the stream just ahead of the `message_end` it describes,
 * while the host still has that call's span open.
 */
export function reportModelCalls(pi: PiApi, now: () => number = Date.now) {
  let call: {
    sentAt: number;
    status?: number;
    respondedAt?: number;
    firstAt?: number;
  } | null = null;

  pi.on('before_provider_request', () => {
    call = { sentAt: now() };
    return undefined;
  });

  pi.on('after_provider_response', (event: { status?: unknown }) => {
    if (call && typeof event.status === 'number') {
      call.status = event.status;
      call.respondedAt = now();
    }
  });

  pi.on('message_update', (event: { message?: { role?: unknown } }) => {
    if (
      call &&
      call.firstAt === undefined &&
      event.message?.role === 'assistant'
    ) {
      call.firstAt = now();
    }
  });

  pi.on('message_end', (event: { message?: { role?: unknown } }) => {
    if (!call || event.message?.role !== 'assistant') {
      return;
    }

    const { sentAt, status, respondedAt, firstAt } = call;
    call = null;
    const record: ModelCallRecord = {
      v: 1,
      durationMs: now() - sentAt,
      ...(status !== undefined ? { status } : {}),
      ...(respondedAt !== undefined
        ? { responseMs: respondedAt - sentAt }
        : {}),
      ...(firstAt !== undefined ? { ttftMs: firstAt - sentAt } : {}),
    };

    try {
      pi.appendEntry(MODEL_CALL_ENTRY, record);
    } catch {
      // Telemetry is bookkeeping.
    }
  });
}

function enforceGuardrails(pi: PiApi) {
  const policy = readPolicy();

  // No policy, no guardrails: a broken policy file must not stop the run, and
  // the host-side checks hold either way.
  if (!policy) {
    return;
  }

  let edited = false;
  let checked = false;
  let reminded = false;

  pi.on(
    'tool_call',
    (event: { toolName: string; input: Record<string, unknown> }) => {
      const verdict = checkToolCall(event.toolName, event.input ?? {}, policy);

      if (verdict) {
        return { block: true, reason: blockedReason(verdict) };
      }

      if (event.toolName === 'write' || event.toolName === 'edit') {
        edited = true;
      }
      if (
        event.toolName === 'bash' &&
        isCheckCommand(String(event.input?.command ?? ''), policy)
      ) {
        checked = true;
      }

      return undefined;
    },
  );

  pi.on('agent_end', () => {
    if (!edited || checked || reminded || policy.checks.length === 0) {
      return;
    }

    reminded = true;
    pi.sendUserMessage(checkReminder(policy), { deliverAs: 'followUp' });
  });
}

// ------------------------------------------------------------- vantik tools

/** The parts of the context pack the tools read. Shaped loosely: it is JSON. */
interface PackView {
  issue?: { key?: string; title?: string; description?: string; url?: string };
  definitionOfDone?: Array<{ id: string; body: string; completed: boolean }>;
  guidance?: string;
  subTasks?: Array<{ key: string; title: string; done: boolean }>;
  relations?: Array<{ type: string; key: string; title: string }>;
  comments?: Array<{ author: string | null; at: string; body: string }>;
  knowledge?: Array<{
    entryId: string;
    kind: string;
    scope: string | null;
    body: string;
  }>;
}

const text = (value: string) => ({
  content: [{ type: 'text' as const, text: value }],
  details: {},
});

/** The issue as the agent needs it to work, as text. */
export function describeIssue(pack: PackView): string {
  const lines: string[] = [
    `# ${pack.issue?.key ?? 'Issue'}: ${pack.issue?.title ?? ''}`.trim(),
    '',
    pack.issue?.description?.trim() || '(No description.)',
  ];

  if (pack.definitionOfDone?.length) {
    lines.push('', '## Definition of Done', '');
    for (const criterion of pack.definitionOfDone) {
      lines.push(
        `- [${criterion.completed ? 'x' : ' '}] ${criterion.body} (id: ${criterion.id})`,
      );
    }
  }
  if (pack.guidance?.trim()) {
    lines.push(
      '',
      '## What the person delegating asked',
      '',
      pack.guidance.trim(),
    );
  }
  if (pack.subTasks?.length) {
    lines.push('', '## Sub-tasks', '');
    for (const task of pack.subTasks) {
      lines.push(`- [${task.done ? 'x' : ' '}] ${task.key} ${task.title}`);
    }
  }
  if (pack.relations?.length) {
    lines.push('', '## Related issues', '');
    for (const relation of pack.relations) {
      lines.push(`- ${relation.type}: ${relation.key} ${relation.title}`);
    }
  }
  if (pack.comments?.length) {
    lines.push('', '## Latest notes', '');
    for (const comment of pack.comments.slice(-5)) {
      lines.push(
        `- ${comment.author ?? 'Someone'}, ${comment.at}: ${comment.body.slice(0, 1500)}`,
      );
    }
  }
  return lines.join('\n');
}

/** The knowledge items that share a word with the query; all of them without one. */
export function findKnowledge(pack: PackView, query: string): string {
  const items = pack.knowledge ?? [];
  if (!items.length) {
    return 'The workspace gave this run no knowledge. Read the repository instead.';
  }

  const words = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
  const scored = items
    .map((item) => ({
      item,
      score: words.length
        ? words.filter((w) =>
            `${item.scope ?? ''} ${item.body}`.toLowerCase().includes(w),
          ).length
        : 1,
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  if (!scored.length) {
    return `Nothing the workspace knows matches "${query}". ${items.length} items exist; call again with no query to see them all.`;
  }
  return scored
    .map(
      ({ item }) =>
        `- ${item.kind}${item.scope ? ` (${item.scope})` : ''}: ${item.body}`,
    )
    .join('\n');
}

function registerVantikTools(pi: PiApi) {
  const policy = readPolicy();
  const { contextPath, outboxPath } = policy ?? {};
  if (!pi.registerTool || !contextPath || !outboxPath) {
    return;
  }

  const pack = (): PackView => {
    try {
      return JSON.parse(readFileSync(contextPath, 'utf8')) as PackView;
    } catch {
      return {};
    }
  };
  const queue = (item: OutboxItem) =>
    appendFileSync(outboxPath, `${JSON.stringify(item)}\n`);
  const required = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`${name} is required.`);
    }
    return value.trim();
  };

  pi.registerTool({
    name: 'vantik_issue',
    label: 'Vantik issue',
    description:
      'The Vantik issue this run works: its description, Definition of Done with criterion ids, sub-tasks, related issues and latest notes. Read it before you start and whenever you are unsure what done means.',
    promptSnippet:
      'vantik_issue: the issue you are working, with its Definition of Done',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => text(describeIssue(pack())),
  });

  pi.registerTool({
    name: 'vantik_knowledge',
    label: 'Vantik knowledge',
    description:
      'What the workspace already knows that bears on this issue: facts, decisions, conventions and gotchas, each written by a person or an earlier agent. Search it before you guess how something works here.',
    promptSnippet: 'vantik_knowledge: what the workspace knows about this area',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Words to match. Leave empty for everything.',
        },
      },
      additionalProperties: false,
    },
    execute: async (_id, params) =>
      text(
        findKnowledge(
          pack(),
          typeof params.query === 'string' ? params.query : '',
        ),
      ),
  });

  pi.registerTool({
    name: 'vantik_note',
    label: 'Note on the issue',
    description:
      'Post a note on the issue for the people tracking it: what you found, a decision you made and why, or something they need to know. Not a progress log, and not your final summary, which the host posts for you.',
    parameters: {
      type: 'object',
      properties: { body: { type: 'string', description: 'Markdown.' } },
      required: ['body'],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      queue({ v: 1, type: 'note', body: required(params.body, 'body') });
      return text('Queued. The host posts it on the issue after this pass.');
    },
  });

  pi.registerTool({
    name: 'vantik_criterion_met',
    label: 'Criterion met',
    description:
      'Mark one Definition of Done criterion as met, by its id from vantik_issue, with the evidence: the test or check that shows it. It is ticked on the issue only if the run finishes and its checks pass.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The criterion id from vantik_issue.',
        },
        evidence: { type: 'string', description: 'What shows it is met.' },
      },
      required: ['id', 'evidence'],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const id = required(params.id, 'id');
      if (!pack().definitionOfDone?.some((c) => c.id === id)) {
        throw new Error(
          `No criterion has the id ${id}. Call vantik_issue for the ids.`,
        );
      }
      queue({
        v: 1,
        type: 'criterion',
        id,
        evidence: required(params.evidence, 'evidence'),
      });
      return text(
        'Queued. The host ticks it if the run finishes with its checks passing.',
      );
    },
  });

  pi.registerTool({
    name: 'vantik_remember',
    label: 'Remember',
    description:
      'Record one durable fact about this codebase for the next person or agent: how something works, a decision and its reason, a convention, or a gotcha that cost you time. One fact per call. Cite the files that prove it. It is proposed, not trusted, until it is checked.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The fact, in one or two sentences.',
        },
        kind: {
          type: 'string',
          enum: ['FACT', 'DECISION', 'CONVENTION', 'GOTCHA'],
        },
        citations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'A path in the repository.',
              },
              lines: { type: 'string', description: 'For example 10-24.' },
            },
            required: ['path'],
          },
        },
      },
      required: ['content'],
      additionalProperties: false,
    },
    execute: async (_id, params) => {
      const kind = params.kind;
      const citations = Array.isArray(params.citations)
        ? (params.citations as Array<{ path?: unknown; lines?: unknown }>)
            .filter((c) => typeof c?.path === 'string')
            .map((c) => ({
              path: String(c.path),
              ...(typeof c.lines === 'string' ? { lines: c.lines } : {}),
            }))
        : undefined;
      queue({
        v: 1,
        type: 'remember',
        content: required(params.content, 'content'),
        ...(kind === 'FACT' ||
        kind === 'DECISION' ||
        kind === 'CONVENTION' ||
        kind === 'GOTCHA'
          ? { kind }
          : {}),
        ...(citations?.length ? { citations } : {}),
      });
      return text(
        'Queued. The host records it as a proposed fact after this pass.',
      );
    },
  });
}

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
 * file imports nothing at run time but Node's own `fs`. The rules are exported so the server's
 * tests exercise exactly what the guest runs.
 */
/* eslint-disable turbo/no-undeclared-env-vars -- VANTIK_POLICY is set in the guest by the host, not read by the server. */
import { readFileSync } from 'node:fs';

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
}

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
interface PiApi {
  // The handlers below narrow the event to what they read.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (event: any, ctx: unknown) => unknown): void;
  sendUserMessage(
    content: string,
    options?: { deliverAs?: 'steer' | 'followUp' },
  ): void;
  appendEntry(customType: string, data?: unknown): void;
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
    };
  } catch {
    return null;
  }
}

export default function vantik(pi: PiApi) {
  reportModelCalls(pi);
  enforceGuardrails(pi);
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

/**
 * What each coding agent sends a hook, and what it expects back.
 *
 * The decision is made once, in AgentHooksService, and is the same whichever
 * tool the agent runs in; this file is only the translation at the edges.
 * Claude Code and Codex speak one format — Codex adopted Claude Code's — and
 * Cursor speaks its own. A harness added later is a case here, not a second
 * copy of the rules.
 */
export const HARNESSES = ['claude-code', 'codex', 'cursor'] as const;

export type Harness = (typeof HARNESSES)[number];

/**
 * The moments a hook reports.
 *
 * `prompt` stands in for session start in Claude Code and Codex. Both run their
 * MCP-tool hooks only once the session's MCP servers are connected, which at
 * launch is after SessionStart has already fired — so the first prompt is the
 * earliest moment those hooks can reach Vantik without a second copy of the
 * token. Cursor runs a command at session start, and reports `session-start`.
 */
export const HOOK_EVENTS = ['session-start', 'prompt', 'stop'] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookInput {
  /** The harness's id for the session; Cursor calls it a conversation. */
  sessionId: string | null;
  /** How the session started, where the harness says: `compact`, `resume`… */
  source: string | null;
  /**
   * This stop is Claude Code or Codex already continuing because a stop hook
   * asked. Cursor's `loop_count` is not read as the same thing: it counts
   * follow-ups across the whole conversation, so it would silence every later
   * quiet stretch, and the service's own record already keeps a stretch to one
   * nudge.
   */
  continued: boolean;
}

/** Longer than any harness's id, short enough to put in a cache key. */
const MAX_SESSION_ID_LENGTH = 200;

/**
 * Reads the fields the rules use out of whatever the harness sent.
 *
 * Tolerant on purpose: each harness sends a different superset, a value that
 * came through an MCP hook's `${…}` template may arrive as a string, and a hook
 * that fails on a field it did not need is a hook that stops working after the
 * harness's next release.
 */
export function readHookInput(body: unknown): HookInput {
  const record =
    body !== null && typeof body === 'object'
      ? (body as Record<string, unknown>)
      : {};

  // Cursor's id first: it names the conversation on every hook, while its
  // session id, where one is sent at all, is not promised to match between
  // them. Claude Code and Codex send only `session_id`.
  const sessionId =
    [record.conversation_id, record.session_id].find(
      (value): value is string =>
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= MAX_SESSION_ID_LENGTH,
    ) ?? null;

  const continued =
    record.stop_hook_active === true || record.stop_hook_active === 'true';

  return {
    sessionId,
    source: typeof record.source === 'string' ? record.source : null,
    continued,
  };
}

/**
 * The JSON a harness reads back, carrying `text` — or asking for nothing.
 *
 * An empty object is every harness's "carry on": no context added, the stop
 * allowed. It is also what a hook that has nothing to say, or that failed,
 * returns, so a Vantik that is down leaves the agent exactly as it was.
 */
export function hookOutput(
  harness: Harness,
  event: HookEvent,
  text: string | null,
): Record<string, unknown> {
  if (!text) {
    return {};
  }

  if (harness === 'cursor') {
    if (event === 'session-start') {
      return { additional_context: text };
    }

    if (event === 'stop') {
      // Cursor cannot refuse a stop. What it can do is send a message back in
      // as the next prompt, which comes to the same thing for an agent that
      // was about to walk away from an out-of-date issue.
      return { followup_message: text };
    }

    // Cursor's prompt hook may allow or refuse a prompt, not add to it.
    return {};
  }

  if (event === 'stop') {
    return { decision: 'block', reason: text };
  }

  return {
    hookSpecificOutput: {
      hookEventName: event === 'prompt' ? 'UserPromptSubmit' : 'SessionStart',
      additionalContext: text,
    },
  };
}

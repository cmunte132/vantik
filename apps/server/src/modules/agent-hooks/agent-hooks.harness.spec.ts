import { hookOutput, readHookInput } from './agent-hooks.harness';
import { duration, stopReason } from './agent-hooks.messages';

describe('reading a hook', () => {
  it("reads Claude Code's and Codex's session id and stop flag", () => {
    expect(
      readHookInput({
        session_id: 'abc',
        hook_event_name: 'Stop',
        stop_hook_active: true,
        cwd: '/work',
      }),
    ).toEqual({ sessionId: 'abc', source: null, continued: true });
  });

  it('reads the flag when an MCP hook template turned it into a string', () => {
    expect(
      readHookInput({ session_id: 'abc', stop_hook_active: 'true' }),
    ).toMatchObject({ continued: true });
    expect(
      readHookInput({ session_id: 'abc', stop_hook_active: 'false' }),
    ).toMatchObject({ continued: false });
  });

  it('names a Cursor session by its conversation', () => {
    // And does not read its loop count as "already continuing": the count
    // spans the conversation, so it would silence every later quiet stretch.
    expect(
      readHookInput({
        conversation_id: 'conv-1',
        session_id: 'other',
        generation_id: 'gen-1',
        status: 'completed',
        loop_count: 1,
      }),
    ).toEqual({ sessionId: 'conv-1', source: null, continued: false });
  });

  it('keeps how the session started', () => {
    expect(readHookInput({ session_id: 'abc', source: 'compact' }).source).toBe(
      'compact',
    );
  });

  it('finds no session in something that is not a hook', () => {
    for (const body of [null, 'text', 42, {}, { session_id: '' }]) {
      expect(readHookInput(body).sessionId).toBeNull();
    }
    expect(readHookInput({ session_id: 'x'.repeat(201) }).sessionId).toBeNull();
  });
});

describe('answering a hook', () => {
  it('asks nothing of any harness when there is nothing to say', () => {
    for (const harness of ['claude-code', 'codex', 'cursor'] as const) {
      for (const event of ['session-start', 'prompt', 'stop'] as const) {
        expect(hookOutput(harness, event, null)).toEqual({});
      }
    }
  });

  it('blocks a Claude Code or Codex stop with the reason', () => {
    for (const harness of ['claude-code', 'codex'] as const) {
      expect(hookOutput(harness, 'stop', 'ENG-42 went quiet.')).toEqual({
        decision: 'block',
        reason: 'ENG-42 went quiet.',
      });
    }
  });

  it('adds the brief as context to the prompt it was submitted with', () => {
    expect(hookOutput('codex', 'prompt', 'Brief.')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'Brief.',
      },
    });
    expect(hookOutput('claude-code', 'session-start', 'Brief.')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'Brief.',
      },
    });
  });

  it("speaks Cursor's format, which follows up rather than blocks", () => {
    expect(hookOutput('cursor', 'session-start', 'Brief.')).toEqual({
      additional_context: 'Brief.',
    });
    expect(hookOutput('cursor', 'stop', 'ENG-42 went quiet.')).toEqual({
      followup_message: 'ENG-42 went quiet.',
    });
    // Cursor's prompt hook cannot add to a prompt, so it gets nothing.
    expect(hookOutput('cursor', 'prompt', 'Brief.')).toEqual({});
  });
});

describe('saying how long', () => {
  it('rounds to what a reader deciding what to do needs', () => {
    expect(duration(20_000)).toBe('1 minute');
    expect(duration(25 * 60_000)).toBe('25 minutes');
    expect(duration(3 * 60 * 60_000)).toBe('3 hours');
    expect(duration(3 * 24 * 60 * 60_000)).toBe('3 days');
  });
});

describe('the stop reason', () => {
  const issue = (key: string) => ({
    id: key,
    key,
    title: 'Some work',
    criteria: { completed: 0, total: 2 },
    lastWrite: null as number | null,
    quietSince: 0,
  });

  it('speaks of one issue, or of several, as they are', () => {
    const now = 25 * 60_000;

    expect(stopReason([issue('ENG-1')], now)).toContain(
      'If this session did not touch it, say so',
    );
    const several = stopReason([issue('ENG-1'), issue('ENG-2')], now);
    expect(several).toContain('If this session worked on one of them');
    expect(several).toContain('If this session did not touch them, say so');
  });
});

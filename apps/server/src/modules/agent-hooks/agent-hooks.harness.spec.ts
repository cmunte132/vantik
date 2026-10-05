import {
  canSay,
  HOOK_EVENTS,
  hookOutput,
  MAX_PROMPT_LENGTH,
  readHookInput,
} from './agent-hooks.harness';
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
    ).toEqual({
      sessionId: 'abc',
      source: null,
      prompt: null,
      toolName: null,
      continued: true,
    });
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
    ).toEqual({
      sessionId: 'conv-1',
      source: null,
      prompt: null,
      toolName: null,
      continued: false,
    });
  });

  it('keeps how the session started', () => {
    expect(readHookInput({ session_id: 'abc', source: 'compact' }).source).toBe(
      'compact',
    );
  });

  it('keeps the prompt, trimmed and cut to what the search reads', () => {
    expect(
      readHookInput({ session_id: 'abc', prompt: '  fix it  ' }).prompt,
    ).toBe('fix it');
    expect(
      readHookInput({ session_id: 'abc', prompt: 'x'.repeat(5_000) }).prompt,
    ).toHaveLength(MAX_PROMPT_LENGTH);
  });

  it('reads a placeholder the harness did not fill in as no prompt', () => {
    // eslint-disable-next-line no-template-curly-in-string
    for (const prompt of ['${prompt}', '', '   ', 42]) {
      expect(readHookInput({ session_id: 'abc', prompt }).prompt).toBeNull();
    }
  });

  it('reads the name of the tool, but not a placeholder for it', () => {
    expect(
      readHookInput({ session_id: 'abc', tool_name: 'Write' }).toolName,
    ).toBe('Write');
    expect(
      // eslint-disable-next-line no-template-curly-in-string
      readHookInput({ session_id: 'abc', tool_name: '${tool_name}' }).toolName,
    ).toBeNull();
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
      for (const event of HOOK_EVENTS) {
        if (harness === 'cursor' && event === 'prompt') {
          continue;
        }
        expect(hookOutput(harness, event, null)).toEqual({});
      }
    }
  });

  it('lets a Cursor prompt through, whatever there is to say', () => {
    // Cursor reads its prompt hook as a gate, and cannot add context to it.
    expect(hookOutput('cursor', 'prompt', null)).toEqual({ continue: true });
    expect(hookOutput('cursor', 'prompt', 'Pointers.')).toEqual({
      continue: true,
    });
  });

  it('knows which events each harness can add context on', () => {
    const table = Object.fromEntries(
      (['claude-code', 'codex', 'cursor'] as const).map((harness) => [
        harness,
        HOOK_EVENTS.filter((event) => canSay(harness, event)),
      ]),
    );

    expect(table).toEqual({
      'claude-code': ['session-start', 'prompt', 'stop'],
      codex: ['session-start', 'prompt', 'stop'],
      cursor: ['session-start', 'tool-use', 'stop'],
    });
  });

  it('never answers a Claude Code or Codex tool hook', () => {
    // It only counts an edit.
    for (const harness of ['claude-code', 'codex'] as const) {
      expect(hookOutput(harness, 'tool-use', 'Anything.')).toEqual({});
    }
  });

  it('gives Cursor what was kept for it after a tool', () => {
    expect(hookOutput('cursor', 'tool-use', 'Pointers.')).toEqual({
      additional_context: 'Pointers.',
    });
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
    inReview: false,
    reviewState: 'In Review' as string | null,
    lastReply: null as number | null,
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

  it('offers the review state of the team as a way to hand the issue over', () => {
    expect(stopReason([issue('ENG-1')], 25 * 60_000)).toContain(
      'update_task to "In Review" and add_note with what to review',
    );
  });

  it('does not offer review when the team has no review state', () => {
    const reason = stopReason(
      [{ ...issue('ENG-1'), reviewState: null }],
      25 * 60_000,
    );

    expect(reason).not.toContain('update_task');
  });
});

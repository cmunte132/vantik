import { describe, expect, it } from 'vitest';

import {
  EDIT_TOOLS,
  MCP_SERVER_NAME,
  contextAppendCommand,
  harnessConfigs,
  hookCommand,
  skillsAddCommand,
} from './harnesses';

const ORIGIN = 'https://vantik.example';

describe('the agent guide install', () => {
  const harnesses = harnessConfigs(`${ORIGIN}/api/v1/mcp`, 'tg_pat_x');

  it('names each tool the way the skills CLI does', () => {
    // An id the CLI does not know is an install that fails on the tab that
    // printed it.
    expect(
      Object.fromEntries(harnesses.map((h) => [h.id, h.skill.agent])),
    ).toEqual({
      'claude-code': 'claude-code',
      codex: 'codex',
      cursor: 'cursor',
      other: undefined,
    });
  });

  it('installs from this instance with telemetry off', () => {
    expect(skillsAddCommand(ORIGIN, 'codex')).toBe(
      'DISABLE_TELEMETRY=1 npx skills add https://vantik.example --agent codex',
    );
  });

  it('leaves the agent to the CLI when the tab does not name one', () => {
    expect(skillsAddCommand(ORIGIN)).toBe(
      'DISABLE_TELEMETRY=1 npx skills add https://vantik.example',
    );
  });

  it('appends the always-in-context form to the file it is named for', () => {
    // Claude Code reads CLAUDE.md, not AGENTS.md; the other tools the reverse.
    const claude = harnesses.find((h) => h.id === 'claude-code');

    expect(claude?.skill.contextFile).toBe('CLAUDE.md');
    expect(contextAppendCommand(ORIGIN, 'CLAUDE.md')).toBe(
      'curl -fsSL https://vantik.example/api/v1/agent-skill/CLAUDE.md >> CLAUDE.md',
    );
  });
});

describe('the hooks', () => {
  const token = 'tg_pat_secret';
  const harnesses = harnessConfigs(`${ORIGIN}/api/v1/mcp`, token);
  const byId = (id: string) => {
    const harness = harnesses.find((h) => h.id === id);
    if (!harness) {
      throw new Error(`no ${id} tab`);
    }
    return harness;
  };

  it('never write the token into a file meant to be committed', () => {
    // The hooks files are project files a team shares. Claude Code and Codex
    // reach Vantik through the MCP connection, Cursor through $VANTIK_TOKEN,
    // and only the one line that sets that variable carries the real value.
    for (const harness of harnesses) {
      for (const block of harness.hooks.blocks) {
        if (block.label === 'Environment') {
          expect(block.value).toBe(`export VANTIK_TOKEN=${token}`);
        } else {
          expect(block.value).not.toContain(token);
        }
      }
    }
  });

  it('call the hook tools on the MCP server the same tab configures', () => {
    for (const id of ['claude-code', 'codex'] as const) {
      const config = JSON.parse(byId(id).hooks.blocks[0].value);
      const handlers = Object.values(config.hooks)
        .flat()
        .flatMap((group) => (group as { hooks: unknown[] }).hooks);

      for (const handler of handlers) {
        expect(handler).toMatchObject({
          type: 'mcp_tool',
          server: MCP_SERVER_NAME,
          input: { session_id: '${session_id}', harness: id },
        });
      }
      // The server key the hooks name is the one the MCP config declares.
      expect(byId(id).blocks[0].value).toContain(MCP_SERVER_NAME);
    }
  });

  it('give Claude Code and Codex the prompt, the compaction and the edits', () => {
    for (const id of ['claude-code', 'codex'] as const) {
      const { hooks } = JSON.parse(byId(id).hooks.blocks[0].value);

      expect(Object.keys(hooks)).toEqual([
        'SessionStart',
        'UserPromptSubmit',
        'PostToolUse',
        'Stop',
      ]);
      expect(hooks.SessionStart).toEqual([
        {
          matcher: 'compact',
          hooks: [
            expect.objectContaining({
              tool: 'hook_session_start',
              input: expect.objectContaining({ source: '${source}' }),
            }),
          ],
        },
      ]);
      expect(hooks.UserPromptSubmit[0].hooks[0]).toMatchObject({
        tool: 'hook_prompt_submit',
        input: { prompt: '${prompt}' },
      });
      expect(hooks.PostToolUse).toEqual([
        {
          matcher: EDIT_TOOLS[id],
          hooks: [
            expect.objectContaining({
              tool: 'hook_tool_use',
              input: expect.objectContaining({ tool_name: '${tool_name}' }),
            }),
          ],
        },
      ]);
      expect(hooks.Stop[0].hooks[0].tool).toBe('hook_stop');
    }
  });

  it('match the edit tool each harness names', () => {
    // Codex makes every change to a file with apply_patch.
    expect(EDIT_TOOLS).toEqual({
      'claude-code': 'Edit|Write|MultiEdit|NotebookEdit',
      codex: 'apply_patch',
    });
  });

  it('give Cursor commands for its own events, answered in its format', () => {
    const config = JSON.parse(byId('cursor').hooks.blocks[0].value);
    const url = (event: string) =>
      `'${ORIGIN}/api/v1/agent-hooks/${event}?harness=cursor'`;

    expect(config.version).toBe(1);
    expect(Object.keys(config.hooks)).toEqual([
      'sessionStart',
      'beforeSubmitPrompt',
      'postToolUse',
      'preCompact',
      'stop',
    ]);
    expect(config.hooks.sessionStart[0].command).toContain(
      url('session-start'),
    );
    expect(config.hooks.beforeSubmitPrompt[0].command).toContain(url('prompt'));
    expect(config.hooks.postToolUse[0].command).toContain(url('tool-use'));
    expect(config.hooks.preCompact[0].command).toContain(url('compact'));
    expect(config.hooks.stop[0].command).toContain(url('stop'));
    // Every tool reaches the server, which gives back what Cursor could not
    // take on the prompt; the server counts only the edits.
    expect(config.hooks.postToolUse[0].matcher).toBeUndefined();
  });

  it('never block a Cursor prompt when Vantik cannot answer', () => {
    // An empty answer to a gate could read as a refusal.
    const config = JSON.parse(byId('cursor').hooks.blocks[0].value);

    expect(config.hooks.beforeSubmitPrompt[0].command).toMatch(
      /\|\| echo '\{"continue":true\}'$/,
    );
  });

  it('carry on when Vantik cannot answer', () => {
    // `{}` is every harness's "carry on"; a hook that fails loudly on every
    // prompt is one people delete.
    expect(hookCommand(`${ORIGIN}/api/v1/agent-hooks`, 'stop', 'cursor')).toBe(
      `curl -fsS -m 10 -X POST '${ORIGIN}/api/v1/agent-hooks/stop?harness=cursor' ` +
        `-H "Authorization: Bearer $VANTIK_TOKEN" -H 'Content-Type: application/json' ` +
        `--data-binary @- || echo '{}'`,
    );
  });
});

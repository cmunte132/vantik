import { describe, expect, it } from 'vitest';

import {
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
      const handlers = [
        ...config.hooks.UserPromptSubmit,
        ...config.hooks.Stop,
      ].flatMap((group: { hooks: unknown[] }) => group.hooks);

      expect(handlers).toEqual([
        {
          type: 'mcp_tool',
          server: MCP_SERVER_NAME,
          tool: 'hook_prompt_submit',
          input: { session_id: '${session_id}', harness: id },
        },
        {
          type: 'mcp_tool',
          server: MCP_SERVER_NAME,
          tool: 'hook_stop',
          input: { session_id: '${session_id}', harness: id },
        },
      ]);
      // The server key the hooks name is the one the MCP config declares.
      expect(byId(id).blocks[0].value).toContain(MCP_SERVER_NAME);
    }
  });

  it('give Cursor commands for its own events, answered in its format', () => {
    const config = JSON.parse(byId('cursor').hooks.blocks[0].value);

    expect(config.version).toBe(1);
    expect(Object.keys(config.hooks)).toEqual(['sessionStart', 'stop']);
    expect(config.hooks.sessionStart[0].command).toContain(
      `'${ORIGIN}/api/v1/agent-hooks/session-start?harness=cursor'`,
    );
    expect(config.hooks.stop[0].command).toContain(
      `'${ORIGIN}/api/v1/agent-hooks/stop?harness=cursor'`,
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

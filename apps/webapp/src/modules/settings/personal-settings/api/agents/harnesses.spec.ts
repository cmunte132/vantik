import { describe, expect, it } from 'vitest';

import {
  contextAppendCommand,
  harnessConfigs,
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

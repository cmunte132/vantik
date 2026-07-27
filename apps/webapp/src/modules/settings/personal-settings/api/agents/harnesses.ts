/**
 * Per-harness MCP connection config. One agent token, many client formats — so
 * a user can connect Claude Code, Codex, Cursor, or anything else that speaks
 * MCP, without hunting for the right shape. Each harness is just a set of
 * copy-paste blocks built from the endpoint and the token.
 */

export interface HarnessBlock {
  label: string;
  value: string;
}

/**
 * How this tool wants the issue-filing guide installed. Every runner reads a
 * different file from a different place — a Claude Code skill, an AGENTS.md, a
 * Cursor rule — so the download has to follow the tab rather than hand everyone
 * the same two files and leave them to work out which one applies.
 */
export interface HarnessSkill {
  /** Name to fetch from /v1/agent-skill; also the downloaded filename. */
  file: string;
  /** Where it belongs, in this tool's terms. */
  target: string;
  /** One-line install, filled in with the served URL. */
  install: (url: string) => string;
  /** The other form this tool accepts, when it accepts one. */
  alternative?: { file: string; target: string; note: string };
}

export interface Harness {
  id: string;
  label: string;
  intro: string;
  blocks: HarnessBlock[];
  skill: HarnessSkill;
}

/**
 * Stands in for the token in the setup instructions, which are worth reading
 * before you have one — that is the whole point of showing them up front.
 */
export const TOKEN_PLACEHOLDER = 'YOUR_VANTIK_TOKEN';

export function harnessConfigs(url: string, token: string): Harness[] {
  const auth = `Bearer ${token}`;

  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      intro:
        'Add to a project’s .mcp.json (or ~/.claude.json for every project), or run the CLI command once.',
      blocks: [
        {
          label: '.mcp.json',
          value: JSON.stringify(
            {
              mcpServers: {
                vantik: {
                  type: 'http',
                  url,
                  headers: { Authorization: auth },
                },
              },
            },
            null,
            2,
          ),
        },
        {
          label: 'claude mcp add',
          value: `claude mcp add --transport http vantik ${url} --header "Authorization: ${auth}"`,
        },
      ],
      skill: {
        file: 'SKILL.md',
        target: '.claude/skills/working-vantik-issues/SKILL.md',
        install: (fileUrl) =>
          `mkdir -p .claude/skills/working-vantik-issues && curl -fsSL ${fileUrl} -o .claude/skills/working-vantik-issues/SKILL.md`,
        alternative: {
          file: 'CLAUDE.md',
          target: 'CLAUDE.md',
          note: 'Keeps it always in context instead of loading on demand.',
        },
      },
    },
    {
      id: 'codex',
      label: 'Codex',
      intro:
        'Add to ~/.codex/config.toml. Codex speaks MCP over stdio, so mcp-remote bridges the HTTP endpoint for it.',
      blocks: [
        {
          label: '~/.codex/config.toml',
          value:
            `[mcp_servers.vantik]\n` +
            `command = "npx"\n` +
            `args = ["-y", "mcp-remote", "${url}", "--header", "Authorization: ${auth}"]`,
        },
      ],
      skill: {
        file: 'AGENTS.md',
        target: 'AGENTS.md, in your project root',
        install: (fileUrl) => `curl -fsSL ${fileUrl} >> AGENTS.md`,
      },
    },
    {
      id: 'cursor',
      label: 'Cursor',
      intro:
        'Add to .cursor/mcp.json in a project, or ~/.cursor/mcp.json to use it everywhere.',
      blocks: [
        {
          label: '.cursor/mcp.json',
          value: JSON.stringify(
            {
              mcpServers: { vantik: { url, headers: { Authorization: auth } } },
            },
            null,
            2,
          ),
        },
      ],
      skill: {
        file: 'working-vantik-issues.mdc',
        target: '.cursor/rules/working-vantik-issues.mdc',
        install: (fileUrl) =>
          `mkdir -p .cursor/rules && curl -fsSL ${fileUrl} -o .cursor/rules/working-vantik-issues.mdc`,
        alternative: {
          file: 'AGENTS.md',
          target: 'AGENTS.md',
          note: 'Cursor reads this too, if you keep one already.',
        },
      },
    },
    {
      id: 'other',
      label: 'Other',
      intro:
        'Point any MCP client at the Streamable HTTP endpoint with the token as an Authorization header. For a client that only speaks stdio, bridge it with mcp-remote.',
      blocks: [
        { label: 'Endpoint (Streamable HTTP)', value: url },
        {
          label: 'Authorization header',
          value: `Authorization: ${auth}`,
        },
        {
          label: 'stdio bridge',
          value: `npx -y mcp-remote ${url} --header "Authorization: ${auth}"`,
        },
      ],
      skill: {
        file: 'AGENTS.md',
        target: 'AGENTS.md, in your project root',
        install: (fileUrl) => `curl -fsSL ${fileUrl} >> AGENTS.md`,
      },
    },
  ];
}

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
 * How this tool takes the agent guides.
 *
 * The install is the same for every tool — the skills CLI reads this instance's
 * discovery index and knows where each agent keeps its skills — so all a tab
 * has to say is which agent it is, and which file that agent always reads, for
 * anyone who would rather keep the guidance in context than load it on demand.
 */
export interface HarnessSkill {
  /** The skills CLI's `--agent` id. Omitted, the CLI detects or asks. */
  agent?: string;
  /** Where the always-in-context form goes. Also its name on /v1/agent-skill. */
  contextFile: 'CLAUDE.md' | 'AGENTS.md';
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
      skill: { agent: 'claude-code', contextFile: 'CLAUDE.md' },
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
      skill: { agent: 'codex', contextFile: 'AGENTS.md' },
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
      skill: { agent: 'cursor', contextFile: 'AGENTS.md' },
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
      // No agent: the CLI detects which ones are installed, or asks.
      skill: { contextFile: 'AGENTS.md' },
    },
  ];
}

/**
 * The one-line install of the agent guides, from this instance.
 *
 * Telemetry is off because, for a source that is not a public GitHub
 * repository, the skills CLI reports the host it installed from, and the host
 * name of a self-hosted tracker is nobody else's business.
 */
export function skillsAddCommand(origin: string, agent?: string): string {
  return `DISABLE_TELEMETRY=1 npx skills add ${origin}${agent ? ` --agent ${agent}` : ''}`;
}

/**
 * The issues guide appended to the file a tool always reads, for an agent that
 * reports only at the end with the skill loaded on demand: nothing in the task
 * looked like issue work until the task was done.
 */
export function contextAppendCommand(
  origin: string,
  file: HarnessSkill['contextFile'],
): string {
  return `curl -fsSL ${origin}/api/v1/agent-skill/${file} >> ${file}`;
}

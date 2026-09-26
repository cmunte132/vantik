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

/**
 * The hooks that make the tracker's rules checked rather than advised: a brief
 * on the first prompt of a session, and a check before the agent stops. The
 * rules live on the server, so each tab is only a different way of asking it.
 */
export interface HarnessHooks {
  intro: string;
  blocks: HarnessBlock[];
}

export interface Harness {
  id: string;
  label: string;
  intro: string;
  blocks: HarnessBlock[];
  skill: HarnessSkill;
  hooks: HarnessHooks;
}

/**
 * Stands in for the token in the setup instructions, which are worth reading
 * before you have one — that is the whole point of showing them up front.
 */
export const TOKEN_PLACEHOLDER = 'YOUR_VANTIK_TOKEN';

/** The MCP server key every config on this page uses, and the hooks name. */
export const MCP_SERVER_NAME = 'vantik';

export function harnessConfigs(url: string, token: string): Harness[] {
  const auth = `Bearer ${token}`;
  const hooksUrl = url.replace(/\/mcp$/, '/agent-hooks');
  const tokenEnv = {
    label: 'Environment',
    value: `export VANTIK_TOKEN=${token}`,
  };

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
      hooks: {
        intro:
          'Merge into .claude/settings.json in the project, or ~/.claude/settings.json for every project. The hooks go through the vantik MCP server above, so they hold no token and the file can be committed.',
        blocks: [
          {
            label: '.claude/settings.json',
            value: mcpToolHooks('claude-code'),
          },
        ],
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
      skill: { agent: 'codex', contextFile: 'AGENTS.md' },
      hooks: {
        intro:
          'Save as .codex/hooks.json in the project, or ~/.codex/hooks.json for every project. Codex asks you to trust new hooks before they run. The hooks go through the vantik MCP server above, so they hold no token.',
        blocks: [{ label: '.codex/hooks.json', value: mcpToolHooks('codex') }],
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
      skill: { agent: 'cursor', contextFile: 'AGENTS.md' },
      hooks: {
        intro:
          'Save as .cursor/hooks.json in the project, or ~/.cursor/hooks.json, and set VANTIK_TOKEN wherever Cursor is started from. Cursor runs hooks as shell commands (macOS and Linux), and it cannot hold an agent at a stop: the reminder comes back as the next message instead.',
        blocks: [
          { label: '.cursor/hooks.json', value: cursorHooks(hooksUrl) },
          tokenEnv,
        ],
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
      // No agent: the CLI detects which ones are installed, or asks.
      skill: { contextFile: 'AGENTS.md' },
      hooks: {
        intro:
          'Any harness that runs a command at session start and before it stops can use the same endpoint: send the hook’s own input as the body, and name the output format to answer in with ?harness= (claude-code, codex or cursor).',
        blocks: [
          {
            label: 'Endpoint',
            value: `${hooksUrl}/{session-start | prompt | stop}?harness={claude-code | codex | cursor}`,
          },
          {
            label: 'As a command hook',
            value: hookCommand(hooksUrl, 'stop', 'claude-code'),
          },
          tokenEnv,
        ],
      },
    },
  ];
}

/**
 * Claude Code and Codex: hooks that call the hook tools on the MCP server the
 * same tab configures. They carry no token — the connection already has one —
 * so the file can be committed for a whole team.
 *
 * Only `${session_id}` is templated: it is the one field both harnesses send
 * on both events, and Codex refuses a hook whose placeholder is missing.
 * UserPromptSubmit rather than SessionStart, because neither harness has its
 * MCP servers connected when SessionStart fires at launch, and skips an MCP
 * hook it cannot reach.
 */
export function mcpToolHooks(harness: 'claude-code' | 'codex'): string {
  const call = (tool: string) => ({
    hooks: [
      {
        type: 'mcp_tool',
        server: MCP_SERVER_NAME,
        tool,
        // eslint-disable-next-line no-template-curly-in-string
        input: { session_id: '${session_id}', harness },
      },
    ],
  });

  return JSON.stringify(
    {
      hooks: {
        UserPromptSubmit: [call('hook_prompt_submit')],
        Stop: [call('hook_stop')],
      },
    },
    null,
    2,
  );
}

/**
 * Cursor: its hooks run commands, so each is a `curl` that pipes the hook's
 * input to the endpoint and prints what comes back.
 */
export function cursorHooks(hooksUrl: string): string {
  return JSON.stringify(
    {
      version: 1,
      hooks: {
        sessionStart: [
          { command: hookCommand(hooksUrl, 'session-start', 'cursor') },
        ],
        stop: [{ command: hookCommand(hooksUrl, 'stop', 'cursor') }],
      },
    },
    null,
    2,
  );
}

/**
 * One hook as a shell command. The token is read from the environment rather
 * than written in, so the file holding the command can be committed; and any
 * failure — Vantik down, the token unset — prints `{}`, which every harness
 * reads as "carry on", so a broken hook never stands in the agent's way.
 */
export function hookCommand(
  hooksUrl: string,
  event: 'session-start' | 'prompt' | 'stop',
  harness: 'claude-code' | 'codex' | 'cursor',
): string {
  return (
    `curl -fsS -m 10 -X POST '${hooksUrl}/${event}?harness=${harness}' ` +
    `-H "Authorization: Bearer $VANTIK_TOKEN" -H 'Content-Type: application/json' ` +
    `--data-binary @- || echo '{}'`
  );
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

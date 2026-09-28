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
          'Save as .cursor/hooks.json in the project, or ~/.cursor/hooks.json, and set VANTIK_TOKEN wherever Cursor is started from. Cursor runs hooks as shell commands (macOS and Linux), and it cannot hold an agent at a stop: the reminder comes back as the next message instead. Cursor also cannot add context to a prompt, so the pages of the knowledge bank that match it reach the agent after its first tool.',
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
          'Any harness that runs a command at session start and before it stops can use the same endpoint: send the hook’s own input as the body, and name the output format to answer in with ?harness= (claude-code, codex or cursor). Send the prompt as `prompt` on the prompt event for pointers to the knowledge bank, and report each tool on the tool-use event, with its name as `tool_name`, so the stop check can find work that has no issue.',
        blocks: [
          {
            label: 'Endpoint',
            value: `${hooksUrl}/{session-start | compact | prompt | tool-use | stop}?harness={claude-code | codex | cursor}`,
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
 * Both harnesses use the same four hooks. Only the name of the edit tool is
 * different.
 *
 * - UserPromptSubmit gives the brief on the first prompt, and sends each
 *   prompt, so the server can name the matching pages of the knowledge bank.
 *   It is used in place of SessionStart at launch: at that time the MCP
 *   servers are not connected, and both harnesses skip an MCP hook.
 * - SessionStart with the `compact` matcher gives the brief again. After a
 *   compaction the MCP servers are connected, so both harnesses run the hook.
 * - PostToolUse on the edit tools counts the changed files. The stop check
 *   uses the count to find work that has no issue.
 * - Stop holds up the agent over an issue that went quiet, or over work that
 *   has no issue.
 *
 * Each placeholder names a field that the event sends. Codex refuses a hook if
 * the input of its event does not have the placeholder.
 */
export function mcpToolHooks(harness: 'claude-code' | 'codex'): string {
  const call = (tool: string, input: Record<string, string> = {}) => ({
    type: 'mcp_tool',
    server: MCP_SERVER_NAME,
    tool,
    // eslint-disable-next-line no-template-curly-in-string
    input: { session_id: '${session_id}', harness, ...input },
  });

  /* eslint-disable no-template-curly-in-string */
  return JSON.stringify(
    {
      hooks: {
        SessionStart: [
          {
            matcher: 'compact',
            hooks: [call('hook_session_start', { source: '${source}' })],
          },
        ],
        UserPromptSubmit: [
          { hooks: [call('hook_prompt_submit', { prompt: '${prompt}' })] },
        ],
        PostToolUse: [
          {
            matcher: EDIT_TOOLS[harness],
            hooks: [call('hook_tool_use', { tool_name: '${tool_name}' })],
          },
        ],
        Stop: [{ hooks: [call('hook_stop')] }],
      },
    },
    null,
    2,
  );
  /* eslint-enable no-template-curly-in-string */
}

/**
 * The tools that change a file, as a PostToolUse matcher for each harness.
 * Codex makes each change to a file with `apply_patch`.
 */
export const EDIT_TOOLS = {
  'claude-code': 'Edit|Write|MultiEdit|NotebookEdit',
  codex: 'apply_patch',
} as const;

/**
 * Cursor: its hooks run commands, so each is a `curl` that pipes the hook's
 * input to the endpoint and prints what comes back.
 *
 * Cursor cannot add context on a prompt or a compaction. The server keeps the
 * pointers from `beforeSubmitPrompt` and the brief from `preCompact`, and
 * `postToolUse` gives them to the agent after its next tool. For that reason
 * `postToolUse` has no matcher. The server counts only the tools that change a
 * file.
 */
export function cursorHooks(hooksUrl: string): string {
  return JSON.stringify(
    {
      version: 1,
      hooks: {
        sessionStart: [
          { command: hookCommand(hooksUrl, 'session-start', 'cursor') },
        ],
        beforeSubmitPrompt: [
          {
            command: hookCommand(hooksUrl, 'prompt', 'cursor', {
              continue: true,
            }),
          },
        ],
        postToolUse: [{ command: hookCommand(hooksUrl, 'tool-use', 'cursor') }],
        preCompact: [{ command: hookCommand(hooksUrl, 'compact', 'cursor') }],
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
 * failure — Vantik down, the token unset — prints `fallback`, which the
 * harness reads as "carry on", so a broken hook never stands in the agent's
 * way. For most hooks that is `{}`. A hook that gates, such as Cursor's
 * `beforeSubmitPrompt`, needs an answer that allows the action.
 */
export function hookCommand(
  hooksUrl: string,
  event: 'session-start' | 'compact' | 'prompt' | 'tool-use' | 'stop',
  harness: 'claude-code' | 'codex' | 'cursor',
  fallback: Record<string, unknown> = {},
): string {
  return (
    `curl -fsS -m 10 -X POST '${hooksUrl}/${event}?harness=${harness}' ` +
    `-H "Authorization: Bearer $VANTIK_TOKEN" -H 'Content-Type: application/json' ` +
    `--data-binary @- || echo '${JSON.stringify(fallback)}'`
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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VantikClient } from '@vantikhq/agent-core';
import { z } from 'zod';

/**
 * The tools a harness's hooks call, rather than the model.
 *
 * Claude Code and Codex can both run a hook as a call to a tool on an MCP
 * server that is already connected. Going that way means the hook reuses the
 * connection — and the token — the person already configured, instead of a
 * script on their machine holding a second copy of it. So these are tools, and
 * each one forwards the hook to `/v1/agent-hooks`, where the rules live and
 * where Cursor's `curl` hook lands too.
 *
 * What comes back is the JSON the harness reads as the hook's output, as text,
 * which is how both harnesses read an MCP hook's result. The price of riding
 * the MCP connection is that the model can see these tools too; the
 * descriptions and the server's instructions tell it they are not for it.
 */

const HOOK_HARNESS = z
  .enum(['claude-code', 'codex'])
  .optional()
  .describe('The harness running the hook. Both read the same output.');

const SESSION_ID = z
  .string()
  .max(200)
  .describe("The harness's session id, from the hook's ${session_id}.");

export function registerHookTools(
  server: McpServer,
  client: VantikClient,
): void {
  server.registerTool(
    'hook_prompt_submit',
    {
      title: 'Hook: a prompt was submitted',
      description:
        'Called by the Vantik hook in Claude Code or Codex when a prompt is ' +
        'submitted. Do not call it yourself: it returns hook output, not an ' +
        'answer. On the first prompt of a session it briefs the agent on ' +
        'the issues it has in progress.',
      inputSchema: { session_id: SESSION_ID, harness: HOOK_HARNESS },
    },
    ({ session_id, harness }) => forward(client, 'prompt', session_id, harness),
  );

  server.registerTool(
    'hook_stop',
    {
      title: 'Hook: the agent is about to stop',
      description:
        'Called by the Vantik hook in Claude Code or Codex when the agent is ' +
        'about to stop. Do not call it yourself: it returns hook output, not ' +
        'an answer. It holds the stop once if an issue the agent has in ' +
        'progress has gone quiet.',
      inputSchema: { session_id: SESSION_ID, harness: HOOK_HARNESS },
    },
    ({ session_id, harness }) => forward(client, 'stop', session_id, harness),
  );
}

/**
 * Relays one hook, and says nothing when that fails.
 *
 * A tool error reaches the person as a hook error on every prompt, which is a
 * lot of noise for a reminder; `{}` is every harness's "carry on", and the
 * endpoint has already logged whatever went wrong on its side.
 */
async function forward(
  client: VantikClient,
  event: 'prompt' | 'stop',
  sessionId: string,
  harness: 'claude-code' | 'codex' = 'claude-code',
) {
  let output: unknown = {};

  try {
    output = await client.post(`/agent-hooks/${event}`, {
      query: { harness },
      body: { session_id: sessionId },
    });
  } catch {
    output = {};
  }

  return { content: [{ type: 'text' as const, text: JSON.stringify(output) }] };
}

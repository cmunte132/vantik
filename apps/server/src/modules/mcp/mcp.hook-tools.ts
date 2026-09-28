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

/**
 * The hook sends the prompt as the harness wrote it. The schema has no maximum
 * length, because a schema error is a hook error that the person sees. The
 * tool cuts the prompt before it forwards it.
 */
const PROMPT = z
  .string()
  .optional()
  .describe("The prompt, from the hook's ${prompt}.");

/** The endpoint keeps this much of a prompt. The tool forwards no more. */
const MAX_FORWARDED_PROMPT = 1_000;

export function registerHookTools(
  server: McpServer,
  client: VantikClient,
): void {
  server.registerTool(
    'hook_session_start',
    {
      title: 'Hook: a session started again',
      description:
        'The Vantik hook in Claude Code or Codex calls this tool after a ' +
        'compaction. ' +
        'Do not call it yourself: it returns hook output, not an answer. It ' +
        'gives the agent the brief of its issues in progress again.',
      inputSchema: {
        session_id: SESSION_ID,
        harness: HOOK_HARNESS,
        source: z
          .string()
          .max(40)
          .optional()
          .describe("How the session started, from the hook's ${source}."),
      },
    },
    ({ session_id, harness, source }) =>
      forward(client, 'session-start', session_id, harness, { source }),
  );

  server.registerTool(
    'hook_prompt_submit',
    {
      title: 'Hook: a prompt was submitted',
      description:
        'The Vantik hook in Claude Code or Codex calls this tool for each ' +
        'prompt. Do not call it yourself: it returns hook output, not an ' +
        'answer. On the first prompt of a session, it gives the agent a brief ' +
        'of its issues in progress. On each prompt, it names the pages of the ' +
        'knowledge bank that match the prompt.',
      inputSchema: {
        session_id: SESSION_ID,
        harness: HOOK_HARNESS,
        prompt: PROMPT,
      },
    },
    ({ session_id, harness, prompt }) =>
      forward(client, 'prompt', session_id, harness, {
        prompt: prompt?.slice(0, MAX_FORWARDED_PROMPT),
      }),
  );

  server.registerTool(
    'hook_tool_use',
    {
      title: 'Hook: the agent changed a file',
      description:
        'The Vantik hook in Claude Code or Codex calls this tool after each ' +
        'change to a file. Do not call it yourself: it returns hook output, ' +
        'not an answer. Vantik counts the changes, and the stop hook uses the ' +
        'count to find work that has no issue.',
      inputSchema: {
        session_id: SESSION_ID,
        harness: HOOK_HARNESS,
        tool_name: z
          .string()
          .max(200)
          .optional()
          .describe("The tool that ran, from the hook's ${tool_name}."),
      },
    },
    ({ session_id, harness, tool_name }) =>
      forward(client, 'tool-use', session_id, harness, { tool_name }),
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
  event: 'session-start' | 'prompt' | 'tool-use' | 'stop',
  sessionId: string,
  harness: 'claude-code' | 'codex' = 'claude-code',
  fields: { source?: string; prompt?: string; tool_name?: string } = {},
) {
  let output: unknown = {};

  try {
    output = await client.post(`/agent-hooks/${event}`, {
      query: { harness },
      body: { session_id: sessionId, ...fields },
    });
  } catch {
    output = {};
  }

  return { content: [{ type: 'text' as const, text: JSON.stringify(output) }] };
}

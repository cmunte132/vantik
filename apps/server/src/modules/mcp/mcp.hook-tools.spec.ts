import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VantikAgent, VantikClient } from '@vantikhq/agent-core';

import { registerHookTools } from './mcp.hook-tools';
import { MCP_INSTRUCTIONS } from './mcp.instructions';
import { registerVantikTools } from './mcp.tools';

/**
 * Drives the hook tools through a real MCP client, as a harness's `mcp_tool`
 * hook would, with the Vantik API faked at the fetch boundary.
 */
async function connect(respond: (path: string) => Response) {
  const requests: Array<{ path: string; query: string; body: unknown }> = [];

  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/v1/, '');
    requests.push({
      path,
      query: parsed.search,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    return respond(path);
  }) as unknown as typeof globalThis.fetch;

  const server = new McpServer(
    { name: 'vantik', version: 'test' },
    { instructions: MCP_INSTRUCTIONS },
  );
  const vantik = new VantikClient({
    baseUrl: 'http://vantik.test',
    token: 'tg_pat_test',
    fetch: fetchImpl,
  });
  // The whole surface, as the controller builds it, so the instructions can
  // be checked against the tools that actually exist.
  registerVantikTools(server, new VantikAgent(vantik));
  registerHookTools(server, vantik);

  const client = new Client({ name: 'test-client', version: 'test' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return { client, requests };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0].text;
}

describe('the hook tools', () => {
  it('relays the stop hook and hands back exactly what the endpoint said', async () => {
    const block = { decision: 'block', reason: 'ENG-42 has gone quiet.' };
    const { client, requests } = await connect(() => json(block));

    const result = await client.callTool({
      name: 'hook_stop',
      arguments: { session_id: 'session-1', harness: 'codex' },
    });

    // The harness parses the text the way it parses a command hook's stdout,
    // so it has to be the endpoint's JSON untouched.
    expect(JSON.parse(textOf(result))).toEqual(block);
    expect(result.isError).toBeFalsy();
    expect(requests).toEqual([
      {
        path: '/agent-hooks/stop',
        query: '?harness=codex',
        body: { session_id: 'session-1' },
      },
    ]);
  });

  it('asks for the Claude Code shape when the hook does not say', async () => {
    const { client, requests } = await connect(() => json({}));

    await client.callTool({
      name: 'hook_prompt_submit',
      arguments: { session_id: 'session-1' },
    });

    expect(requests[0].path).toBe('/agent-hooks/prompt');
    expect(requests[0].query).toBe('?harness=claude-code');
  });

  it('says nothing, rather than erroring, when Vantik cannot answer', async () => {
    // A tool error reaches the person as a hook error on every prompt; an
    // empty object is every harness's "carry on".
    const { client } = await connect(() => json({ message: 'down' }, 503));

    const result = await client.callTool({
      name: 'hook_stop',
      arguments: { session_id: 'session-1' },
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({});
  });

  it('tells the model the hook tools are not for it', async () => {
    const { client } = await connect(() => json({}));
    const { tools } = await client.listTools();

    const hookTools = tools.filter((tool) => tool.name.startsWith('hook_'));

    expect(hookTools.map((tool) => tool.name).sort()).toEqual([
      'hook_prompt_submit',
      'hook_session_start',
      'hook_stop',
      'hook_tool_use',
    ]);
    for (const tool of hookTools) {
      expect(tool.description).toContain('Do not call it yourself');
      expect(client.getInstructions()).toContain(tool.name);
    }
    expect(client.getInstructions()).toContain('are called by the hooks');
  });

  it('forwards the prompt, cut to what the endpoint keeps', async () => {
    const { client, requests } = await connect(() => json({}));

    await client.callTool({
      name: 'hook_prompt_submit',
      arguments: { session_id: 'session-1', prompt: 'x'.repeat(5_000) },
    });

    expect(requests[0].body).toEqual({
      session_id: 'session-1',
      prompt: 'x'.repeat(1_000),
    });
  });

  it('forwards how a session started, and an edit, to their events', async () => {
    const { client, requests } = await connect(() => json({}));

    await client.callTool({
      name: 'hook_session_start',
      arguments: { session_id: 'session-1', source: 'compact' },
    });
    const edit = await client.callTool({
      name: 'hook_tool_use',
      arguments: { session_id: 'session-1', tool_name: 'Edit' },
    });

    expect(requests).toEqual([
      {
        path: '/agent-hooks/session-start',
        query: '?harness=claude-code',
        body: { session_id: 'session-1', source: 'compact' },
      },
      {
        path: '/agent-hooks/tool-use',
        query: '?harness=claude-code',
        body: { session_id: 'session-1', tool_name: 'Edit' },
      },
    ]);
    expect(JSON.parse(textOf(edit))).toEqual({});
  });
});

describe('the server instructions', () => {
  it('reach a client that connects', async () => {
    const { client } = await connect(() => json({}));

    expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS);
  });

  it('name only tools the server has', async () => {
    // An instruction naming a tool that was renamed away is an agent calling
    // something that does not exist, on every session, from the one text it
    // cannot avoid reading. Skill names are hyphenated, so this reads tools.
    const { client } = await connect(() => json({}));
    const { tools } = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    const named = MCP_INSTRUCTIONS.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [];

    expect(named.length).toBeGreaterThan(5);
    expect(named.filter((name) => !names.has(name))).toEqual([]);
  });
});

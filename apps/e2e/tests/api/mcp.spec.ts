import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createIssue, getIssue, unique } from '../../src/api';
import { bearer } from '../../src/auth';
import { SERVER_URL } from '../../src/env';
import { expect, test } from '../../src/fixtures';

/**
 * The MCP endpoint is how agents use Vantik. Its tools call the REST API back
 * over loopback with the caller's own token, so none of this can be exercised
 * without a listening server — which is exactly what the unit suite lacks.
 */

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'vantik-e2e', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/v1/mcp', SERVER_URL), {
      requestInit: { headers: bearer(token) },
    }),
  );
  return client;
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const [first] = result.content as Array<{ type: string; text: string }>;
  expect(first?.type).toBe('text');
  return first.text;
}

test.describe('the MCP endpoint', () => {
  test('an agent files a task and reads it back', async ({ alice, asAlice }) => {
    const client = await connect(alice.pat);

    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['create_task', 'get_task', 'list_tasks']),
      );

      const title = unique('Filed over MCP');
      const created = await client.callTool({
        name: 'create_task',
        arguments: {
          // Named, because other tests add teams to Alice's workspace while
          // this one runs, and with more than one the tool refuses to guess.
          team: alice.teamIdentifier,
          title,
          description:
            'The nightly export stalls when a team has more than a thousand ' +
            'issues, and nobody is told that it stopped.',
          acceptanceCriteria: ['The export finishes for a team of 5,000 issues'],
        },
      });
      expect(created.isError, textOf(created)).toBeFalsy();

      const task = JSON.parse(textOf(created)) as { id: string; key: string };
      expect(task.key).toMatch(new RegExp(`^${alice.teamIdentifier}-\\d+$`));

      // What the agent filed is an ordinary issue to everyone else.
      const issue = await getIssue(asAlice, task.id);
      expect(issue.title).toBe(title);
      expect(issue.descriptionMarkdown).toContain('nightly export stalls');

      const fetched = await client.callTool({
        name: 'get_task',
        arguments: { task: task.key },
      });
      expect(fetched.isError, textOf(fetched)).toBeFalsy();
      expect(textOf(fetched)).toContain(title);
    } finally {
      await client.close();
    }
  });

  test("one workspace's agent cannot read another workspace's task", async ({
    alice,
    asAlice,
    bob,
  }) => {
    const issue = await createIssue(asAlice, alice);
    const client = await connect(bob.pat);

    try {
      const result = await client.callTool({
        name: 'get_task',
        arguments: { task: issue.id },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).not.toContain(issue.title);
    } finally {
      await client.close();
    }
  });

  test('the endpoint refuses a caller with no token', async ({ anonymous }) => {
    const response = await anonymous.post('/v1/mcp', {
      headers: { accept: 'application/json, text/event-stream' },
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'vantik-e2e', version: '0.0.0' },
        },
      },
    });
    expect(response.status()).toBe(401);
  });
});

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { VantikAgent, VantikClient } from '@vantikhq/agent-core';

import { registerHookTools } from './mcp.hook-tools';
import { registerVantikTools } from './mcp.tools';

/** `skills/` at the root of the repository. */
const SKILLS = join(__dirname, '../../../../../skills');

async function toolNames(): Promise<string[]> {
  const vantik = new VantikClient({
    baseUrl: 'http://vantik.test',
    token: 'tg_pat_test',
  });
  const server = new McpServer({ name: 'vantik', version: 'test' });
  registerVantikTools(server, new VantikAgent(vantik));
  registerHookTools(server, vantik);

  const client = new Client({ name: 'test-client', version: 'test' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return (await client.listTools()).tools.map((tool) => tool.name);
}

function read(files: string[]): string {
  return files.map((file) => readFileSync(file, 'utf8')).join('\n');
}

const skillFiles = () =>
  readdirSync(SKILLS, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && entry.name !== 'always-in-context',
    )
    .map((entry) => join(SKILLS, entry.name, 'SKILL.md'));

const alwaysInContextFiles = () =>
  readdirSync(join(SKILLS, 'always-in-context')).map((file) =>
    join(SKILLS, 'always-in-context', file),
  );

describe('the agent guides and the tools', () => {
  it('teach every tool an agent is meant to call', async () => {
    // A tool no guide mentions is a feature agents do not find: eight of them
    // once sat unmentioned, delegation among them.
    const guides = read(skillFiles());
    const unmentioned = (await toolNames())
      .filter((name) => !name.startsWith('hook_'))
      // As a word, not only in backticks: a worked example such as
      // `list_tasks(modules: ["server"])` teaches the tool as well as any.
      .filter((name) => !new RegExp(`\\b${name}\\b`).test(guides));

    expect(unmentioned).toEqual([]);
  });

  it('name only tools that exist, in either form', async () => {
    const names = new Set(await toolNames());

    for (const files of [skillFiles(), alwaysInContextFiles()]) {
      const named = read(files).match(/`[a-z]+(?:_[a-z]+)+`/g) ?? [];
      const missing = named
        .map((name) => name.slice(1, -1))
        .filter((name) => !names.has(name));

      expect(missing).toEqual([]);
    }
  });
});

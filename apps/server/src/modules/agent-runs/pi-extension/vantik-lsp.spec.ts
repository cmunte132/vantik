import type { LanguageServerRecord, LspLimits, ServerSpec } from './vantik-lsp';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CodeIntel,
  FrameReader,
  frame,
  LSP_LIMITS,
  registerCodeTools,
} from './vantik-lsp';

/**
 * A language server in thirty lines: answers the requests the tools make,
 * and checks a file the way tsserver would for one rule — a string assigned
 * to a `number` is an error. `hang` never answers `initialize`; `slow`
 * starts but never answers anything after.
 */
const FAKE_SERVER = String.raw`
const mode = process.argv[2] || 'ok';
const previous = {};
let buffer = Buffer.alloc(0);
const send = (m) => {
  const body = JSON.stringify({ jsonrpc: '2.0', ...m });
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n\r\n' + body);
};
const check = (uri, text, version) => send({ method: 'textDocument/publishDiagnostics', params: {
  uri, version: mode === 'stale' ? undefined : version,
  diagnostics: text.split('\n').flatMap((line, i) => /: number = "/.test(line)
    ? [{ range: { start: { line: i, character: line.indexOf(':') - 1 }, end: { line: i, character: line.length } },
         severity: 1, source: 'ts', code: 2322, message: "Type 'string' is not assignable to type 'number'.\nmore" }]
    : []),
} });
const at = (uri, line, character) => ({ uri, range: { start: { line, character }, end: { line, character: character + 1 } } });
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const m = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    buffer = buffer.subarray(end + 4 + length);
    if (m.method === 'initialize') {
      if (mode === 'hang') continue;
      send({ id: m.id, result: { capabilities: {} } });
      send({ id: 99, method: 'workspace/configuration', params: { items: [{}, {}] } });
    } else if (mode === 'slow') {
      continue;
    } else if (m.method === 'textDocument/didOpen') {
      previous[m.params.textDocument.uri] = m.params.textDocument.text;
      check(m.params.textDocument.uri, m.params.textDocument.text, 1);
    } else if (m.method === 'textDocument/didChange' && mode === 'stale') {
      // tsserver's way: no version, and the answer for the old text first.
      check(m.params.textDocument.uri, previous[m.params.textDocument.uri] || '', 0);
      previous[m.params.textDocument.uri] = m.params.contentChanges[0].text;
      setTimeout(() => check(m.params.textDocument.uri, m.params.contentChanges[0].text, 0), 200);
    } else if (m.method === 'textDocument/didChange') {
      check(m.params.textDocument.uri, m.params.contentChanges[0].text, m.params.textDocument.version);
    } else if (m.method === 'textDocument/definition') {
      send({ id: m.id, result: [at(m.params.textDocument.uri.replace('use.ts', 'lib.ts'), 0, 16)] });
    } else if (m.method === 'textDocument/references') {
      send({ id: m.id, result: Array.from({ length: 50 }, (_, i) => at(m.params.textDocument.uri, 0, i)) });
    } else if (m.method === 'textDocument/hover') {
      send({ id: m.id, result: { contents: { kind: 'markdown', value: 'function add(a: number, b: number): number' } } });
    } else if (m.method === 'textDocument/documentSymbol') {
      send({ id: m.id, result: [{ name: 'Box', kind: 5, range: at('', 2, 0).range, selectionRange: at('', 2, 6).range,
        children: [{ name: 'open', kind: 6, range: at('', 3, 2).range, selectionRange: at('', 3, 2).range }] }] });
    } else if (m.method === 'workspace/symbol') {
      send({ id: m.id, result: [
        { name: 'add', kind: 12, location: at(m.params.query && m.params.query === 'add' ? process.argv[3] : '', 0, 16) },
        { name: 'add', kind: 12, location: at('file:///x/node_modules/y/index.d.ts', 0, 0) },
      ] });
    } else if (m.id !== undefined && m.method) {
      send({ id: m.id, result: null });
    }
  }
});
`;

describe('code intelligence', () => {
  let root: string;
  let script: string;
  let intel: CodeIntel | undefined;

  const spec = (mode = 'ok', command = process.execPath): ServerSpec => ({
    id: 'typescript',
    command,
    args: [script, mode, `file://${join(root, 'lib.ts')}`],
    extensions: ['.ts'],
    languageId: () => 'typescript',
  });

  const start = (
    mode?: string,
    records: LanguageServerRecord[] = [],
    limits: Partial<LspLimits> = {},
    command?: string,
  ) => {
    intel = new CodeIntel(
      root,
      (record) => records.push(record),
      [spec(mode, command)],
      { ...LSP_LIMITS, ...limits },
    );
    return intel;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vantik-lsp-'));
    script = join(root, '.fake-server.js');
    writeFileSync(script, FAKE_SERVER);
    writeFileSync(
      join(root, 'lib.ts'),
      'export function add(a: number, b: number) {\n  return a + b;\n}\n',
    );
    writeFileSync(
      join(root, 'use.ts'),
      "import { add } from './lib';\nconst total = add(1, 2);\n",
    );
  });

  afterEach(() => {
    intel?.shutdown();
    intel = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it('frames by bytes, so a message with multi-byte text survives a split', () => {
    const wire = Buffer.from(
      frame({ id: 1, result: 'café' }) + frame({ id: 2 }),
    );
    const reader = new FrameReader();

    expect(reader.push(wire.subarray(0, 30))).toEqual([]);
    expect(reader.push(wire.subarray(30))).toEqual([
      { id: 1, result: 'café' },
      { id: 2 },
    ]);
  });

  it('answers with repo-relative locations and the line itself', async () => {
    const records: LanguageServerRecord[] = [];
    const answer = await start('ok', records).definition('use.ts', 2, 'add');

    expect(answer).toBe(
      'lib.ts:1:17  export function add(a: number, b: number) {',
    );
    expect(records).toEqual([
      expect.objectContaining({
        v: 1,
        server: 'typescript',
        outcome: 'started',
      }),
    ]);
  });

  it('finds the name on a nearby line when the line number is off by one', () => {
    expect(start().locate(join(root, 'use.ts'), 1, 'total')).toEqual({
      line: 1,
      character: 6,
    });
  });

  it('says what the line reads when the name is not on it', () => {
    expect(() => start().locate(join(root, 'lib.ts'), 2, 'nowhere')).toThrow(
      'which reads: return a + b;',
    );
  });

  it('caps a long answer and says how much it left out', async () => {
    const answer = await start().references('lib.ts', 1, 'add');
    const lines = answer.split('\n');

    expect(lines).toHaveLength(LSP_LIMITS.locations + 1);
    expect(lines.at(-1)).toBe('… and 10 more. Narrow the question, or use rg.');
  });

  it('gives hover text, a file outline, and project symbols outside node_modules', async () => {
    const code = start();

    await expect(code.hover('lib.ts', 1, 'add')).resolves.toBe(
      'function add(a: number, b: number): number',
    );
    await expect(code.symbols({ path: 'lib.ts' })).resolves.toBe(
      'class Box  :3\n  method open  :4',
    );
    await expect(code.symbols({ query: 'add' })).resolves.toBe(
      'function add  lib.ts:1',
    );
  });

  it('refuses a path outside the checkout', async () => {
    await expect(start().definition('../etc/passwd.ts', 1)).rejects.toThrow(
      'outside the repository',
    );
  });

  describe('after an edit', () => {
    it('appends the type error a TypeScript edit introduced', async () => {
      const code = start();
      await code.diagnostics('use.ts');

      writeFileSync(
        join(root, 'use.ts'),
        'import { add } from \'./lib\';\nconst total: number = "3";\n',
      );

      await expect(code.afterEdit('use.ts')).resolves.toBe(
        [
          'typescript reports 1 error in use.ts after this change:',
          "2:11 error ts 2322: Type 'string' is not assignable to type 'number'.",
        ].join('\n'),
      );
    });

    it('says the errors are gone once they are, and nothing when there were none', async () => {
      const code = start();
      writeFileSync(join(root, 'use.ts'), 'const n: number = "x";\n');
      await code.afterEdit('use.ts');

      writeFileSync(join(root, 'use.ts'), 'const n: number = 1;\n');
      await expect(code.afterEdit('use.ts')).resolves.toBe(
        'No errors left in use.ts.',
      );

      writeFileSync(join(root, 'use.ts'), 'const n: number = 2;\n');
      await expect(code.afterEdit('use.ts')).resolves.toBeNull();
    });

    it('takes the latest answer from a server that does not say which version it checked', async () => {
      const code = start('stale');
      await code.diagnostics('use.ts');

      writeFileSync(join(root, 'use.ts'), 'const n: number = "x";\n');
      await expect(code.afterEdit('use.ts')).resolves.toContain(
        'typescript reports 1 error in use.ts',
      );

      writeFileSync(join(root, 'use.ts'), 'const n: number = 1;\n');
      await expect(code.afterEdit('use.ts')).resolves.toBe(
        'No errors left in use.ts.',
      );
    });

    it('stays quiet about files no server covers', async () => {
      writeFileSync(join(root, 'notes.md'), '# hi\n');
      await expect(start().afterEdit('notes.md')).resolves.toBeNull();
    });
  });

  describe('when a server cannot help', () => {
    it('reports a server that is not installed, once, and answers at once after', async () => {
      const records: LanguageServerRecord[] = [];
      const code = start('ok', records, {}, '/nonexistent/language-server');

      await expect(code.definition('use.ts', 2, 'add')).rejects.toThrow(
        'could not start',
      );
      await expect(code.hover('use.ts', 2, 'add')).rejects.toThrow(
        'could not start',
      );
      await expect(code.afterEdit('use.ts')).resolves.toBeNull();
      expect(records).toEqual([
        expect.objectContaining({ server: 'typescript', outcome: 'failed' }),
      ]);
    });

    it('gives up on a server that never finishes starting', async () => {
      const records: LanguageServerRecord[] = [];
      const code = start('hang', records, { startMs: 300 });

      await expect(code.definition('use.ts', 2, 'add')).rejects.toThrow(
        'did not start within 0.3s',
      );
      expect(records).toEqual([
        expect.objectContaining({ outcome: 'timeout' }),
      ]);
    });

    it('writes off a server that stops answering', async () => {
      const records: LanguageServerRecord[] = [];
      const code = start('slow', records, { requestMs: 100, timeouts: 2 });

      await expect(code.hover('use.ts', 2, 'add')).rejects.toThrow(
        'took longer than 0.1s',
      );
      await expect(code.hover('use.ts', 2, 'add')).rejects.toThrow(
        'took longer',
      );
      await expect(code.hover('use.ts', 2, 'add')).rejects.toThrow(
        'stopped answering',
      );
      expect(records.map((record) => record.outcome)).toEqual([
        'started',
        'timeout',
      ]);
    });

    it('does not hold an edit up waiting for diagnostics that never come', async () => {
      const code = start('slow', [], { diagnosticsMs: 100 });
      await expect(code.afterEdit('use.ts')).resolves.toBeNull();
    });
  });

  describe('as Pi tools', () => {
    function register() {
      const tools: Record<
        string,
        (params: Record<string, unknown>) => Promise<string>
      > = {};
      const handlers: Record<string, (event: unknown) => unknown> = {};
      const entries: Array<{ customType: string; data: unknown }> = [];
      intel =
        registerCodeTools(
          {
            on: (event, handler) => {
              handlers[event] = handler as (event: unknown) => unknown;
            },
            sendUserMessage: () => undefined,
            appendEntry: (customType, data) =>
              entries.push({ customType, data }),
            registerTool: (tool) => {
              tools[tool.name] = async (params) =>
                (await tool.execute('call-1', params)).content[0].text;
            },
          },
          root,
        ) ?? undefined;
      return { tools, handlers, entries };
    }

    it('registers the five code tools and the edit hook', () => {
      const { tools, handlers } = register();

      expect(Object.keys(tools).sort()).toEqual([
        'code_definition',
        'code_diagnostics',
        'code_hover',
        'code_references',
        'code_symbols',
      ]);
      expect(handlers.tool_result).toBeDefined();
      expect(handlers.session_shutdown).toBeDefined();
    });

    it('turns a failure into advice instead of an error', async () => {
      const { tools } = register();
      writeFileSync(join(root, 'notes.md'), '# hi\n');

      await expect(
        tools.code_definition({ path: 'notes.md', line: 1 }),
      ).resolves.toContain('Use `rg` to search');
    });

    it('leaves a failed or unrelated tool result alone', async () => {
      const { handlers } = register();

      await expect(
        handlers.tool_result({
          toolName: 'edit',
          isError: true,
          input: { path: 'use.ts' },
        }),
      ).resolves.toBeUndefined();
      await expect(
        handlers.tool_result({ toolName: 'bash', input: { command: 'ls' } }),
      ).resolves.toBeUndefined();
    });
  });
});

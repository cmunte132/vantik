/**
 * Code intelligence for the agent: the guest image's language servers, asked
 * the questions an agent otherwise answers with grep.
 *
 * Part of the Vantik extension and seeded beside it (see seed.ts), so the same
 * rules apply: it runs inside the guest, as the agent, and is capability, not
 * a boundary. Self-contained for the same reason — the guest has no
 * node_modules of ours — so it speaks the Language Server Protocol itself over
 * the server's stdio, which is a few dozen lines, rather than importing a
 * client.
 *
 * Every server starts lazily, on the first question about a file in its
 * language, and every wait is bounded. A server that will not start, or stops
 * answering, costs the agent one clear message telling it to use grep and the
 * checks instead — never a run that hangs.
 */
import type { PiApi } from './vantik-extension';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/** What the extension records about each server, for the run's telemetry. */
export const LANGUAGE_SERVER_ENTRY = 'vantik.language_server';

export interface LanguageServerRecord {
  v: 1;
  server: string;
  outcome: 'started' | 'failed' | 'timeout';
  /** From spawn to the answer to `initialize`, or to giving up. */
  ms: number;
}

export interface ServerSpec {
  id: string;
  command: string;
  args: string[];
  /** Lower-case, with the dot. */
  extensions: string[];
  languageId(extension: string): string;
  initializationOptions?: Record<string, unknown>;
}

/** The servers the guest image installs (apps/sandbox-host/guest). */
export const LANGUAGE_SERVERS: ServerSpec[] = [
  {
    id: 'typescript',
    command: 'typescript-language-server',
    args: ['--stdio'],
    initializationOptions: {
      // The syntax-only server answers while the project loads, and cannot
      // see through an import: a definition then stops at the import line.
      // Waiting for the real project is slower once and right every time.
      // Capped below the run's 4 GiB so the agent's own builds keep room.
      tsserver: { useSyntaxServer: 'never' },
      maxTsServerMemory: 1536,
    },
    extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
    languageId: (extension) =>
      ({ '.tsx': 'typescriptreact', '.jsx': 'javascriptreact' })[extension] ??
      (/^\.[mc]?js$/.test(extension) ? 'javascript' : 'typescript'),
  },
  {
    id: 'python',
    command: 'pyright-langserver',
    args: ['--stdio'],
    extensions: ['.py', '.pyi'],
    languageId: () => 'python',
  },
];

export interface LspLimits {
  startMs: number;
  requestMs: number;
  diagnosticsMs: number;
  settleMs: number;
  timeouts: number;
  locations: number;
  symbols: number;
  diagnostics: number;
  editErrors: number;
  hoverChars: number;
}

export const LSP_LIMITS: Readonly<LspLimits> = {
  /** From spawn to `initialize` answered. A big project takes a while. */
  startMs: 60_000,
  requestMs: 20_000,
  /** How long an edit waits for the server to re-check the file. */
  diagnosticsMs: 8_000,
  /** How long an unversioned answer waits for a newer one. */
  settleMs: 750,
  /** Consecutive timeouts before a server is written off for the run. */
  timeouts: 3,
  locations: 40,
  symbols: 80,
  diagnostics: 25,
  /** Errors appended to an edit's result. */
  editErrors: 10,
  hoverChars: 2_000,
};

// ------------------------------------------------------------------ framing

/** One JSON-RPC message, framed as LSP frames it. */
export function frame(message: unknown): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

/** Splits a server's stdout into messages. Bytes, not characters, are counted. */
export class FrameReader {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];

    for (;;) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        break;
      }
      const length = /content-length:\s*(\d+)/i.exec(
        this.buffer.subarray(0, end).toString('ascii'),
      )?.[1];
      if (!length) {
        // Not a header we can read: drop it rather than wedge on it forever.
        this.buffer = this.buffer.subarray(end + 4);
        continue;
      }
      const start = end + 4;
      const stop = start + Number(length);
      if (this.buffer.length < stop) {
        break;
      }
      try {
        messages.push(
          JSON.parse(this.buffer.subarray(start, stop).toString('utf8')),
        );
      } catch {
        // A malformed message is skipped; the next one is still framed.
      }
      this.buffer = this.buffer.subarray(stop);
    }

    return messages;
  }
}

// --------------------------------------------------------------- connection

class TimeoutError extends Error {}

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
}

interface Diagnostic {
  range: Range;
  severity?: number;
  message: string;
  source?: string;
  code?: string | number;
}

interface Range {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/** One running server, and what it has told us. */
class Server {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  readonly open = new Map<string, { version: number; text: string }>();
  readonly diagnostics = new Map<string, Diagnostic[]>();
  private published = new Map<string, Set<(version?: number) => void>>();
  timeouts = 0;
  exited: string | null = null;

  constructor(private child: ChildProcessWithoutNullStreams) {
    const reader = new FrameReader();
    child.stdout.on('data', (chunk: Buffer) => {
      for (const message of reader.push(chunk)) {
        this.receive(message as RpcMessage);
      }
    });
    // Servers log to stderr. Read it so a chatty one cannot fill the pipe
    // and stall, and drop it: it is not the agent's to read.
    child.stderr.on('data', () => undefined);
    child.stdin.on('error', () => undefined);
    child.on('exit', (code, signal) => {
      this.exited = `exited (${signal ?? code})`;
      for (const { reject } of this.pending.values()) {
        reject(new Error(`the language server ${this.exited}`));
      }
      this.pending.clear();
    });
  }

  private send(message: object) {
    if (!this.exited) {
      this.child.stdin.write(frame({ jsonrpc: '2.0', ...message }));
    }
  }

  private receive(message: RpcMessage) {
    if (message.method && message.id !== undefined) {
      // A request from the server. Answer the ones servers wait on with the
      // empty answer, which every server accepts as "use your defaults".
      this.send({
        id: message.id,
        result:
          message.method === 'workspace/configuration'
            ? ((message.params as { items?: unknown[] })?.items ?? []).map(
                (): null => null,
              )
            : null,
      });
      return;
    }
    if (message.method === 'textDocument/publishDiagnostics') {
      const params = message.params as {
        uri: string;
        version?: number;
        diagnostics: Diagnostic[];
      };
      this.diagnostics.set(params.uri, params.diagnostics ?? []);
      for (const notify of [...(this.published.get(params.uri) ?? [])]) {
        notify(typeof params.version === 'number' ? params.version : undefined);
      }
      return;
    }
    if (typeof message.id === 'number') {
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        waiter?.reject(new Error(message.error.message ?? 'request failed'));
      } else {
        waiter?.resolve(message.result);
      }
    }
  }

  request(method: string, params: unknown, ms: number): Promise<unknown> {
    if (this.exited) {
      return Promise.reject(new Error(`the language server ${this.exited}`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TimeoutError(`${method} took longer than ${ms / 1000}s`));
      }, ms);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    this.send({ method, params });
  }

  /**
   * Resolves once the server has checked `uri` as it is now: true when it
   * has, false after `ms` without a word.
   *
   * Pyright says which version of the file it checked, so an answer for an
   * older one is skipped. tsserver does not, and the answer for the text
   * before an edit can land just after the edit is sent, so an unversioned
   * answer waits `settleMs` for another and the last one stands.
   */
  nextDiagnostics(uri: string, ms: number, settleMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const waiters = this.published.get(uri) ?? new Set();
      this.published.set(uri, waiters);
      let settle: NodeJS.Timeout | undefined;
      let heard = false;
      const finish = (checked: boolean) => {
        clearTimeout(timer);
        clearTimeout(settle);
        waiters.delete(notify);
        resolve(checked);
      };
      const notify = (version?: number) => {
        if (version === undefined) {
          heard = true;
          clearTimeout(settle);
          settle = setTimeout(() => finish(true), settleMs);
        } else if (version >= (this.open.get(uri)?.version ?? 0)) {
          finish(true);
        }
      };
      const timer = setTimeout(() => finish(heard), ms);
      waiters.add(notify);
    });
  }

  kill() {
    this.child.kill('SIGKILL');
  }
}

// -------------------------------------------------------------- code intel

type Report = (record: LanguageServerRecord) => void;

const FALLBACK =
  'Use `rg` to search, and run the project checks to see type errors.';

/**
 * The servers for one checkout, started on demand.
 *
 * Each answer is text for a model: repo-relative `path:line:col` with the line
 * itself, capped, never raw protocol JSON.
 */
export class CodeIntel {
  private servers = new Map<string, Promise<Server>>();
  private failed = new Map<string, string>();
  private running = new Map<string, Server>();

  constructor(
    readonly root: string,
    private report: Report = () => undefined,
    private specs: ServerSpec[] = LANGUAGE_SERVERS,
    private limits: Readonly<LspLimits> = LSP_LIMITS,
  ) {}

  specFor(path: string): ServerSpec | undefined {
    const extension = extname(path).toLowerCase();
    return this.specs.find((spec) => spec.extensions.includes(extension));
  }

  /** A path the agent named, made absolute and kept inside the checkout. */
  resolvePath(path: string): string {
    const absolute = isAbsolute(path) ? path : resolve(this.root, path);
    const inside = relative(this.root, absolute);
    if (inside.startsWith('..') || isAbsolute(inside)) {
      throw new Error(`${path} is outside the repository.`);
    }
    return absolute;
  }

  private display(uriOrPath: string): string {
    const path = uriOrPath.startsWith('file:')
      ? fileURLToPath(uriOrPath)
      : uriOrPath;
    const inside = relative(this.root, path);
    return inside.startsWith('..') ? path : inside;
  }

  private server(spec: ServerSpec): Promise<Server> {
    const failure = this.failed.get(spec.id);
    if (failure) {
      return Promise.reject(new Error(failure));
    }
    let started = this.servers.get(spec.id);
    if (!started) {
      started = this.start(spec);
      this.servers.set(spec.id, started);
    }
    return started;
  }

  private async start(spec: ServerSpec): Promise<Server> {
    const began = Date.now();
    const giveUp = (outcome: 'failed' | 'timeout', reason: string) => {
      this.failed.set(spec.id, reason);
      this.servers.delete(spec.id);
      this.report({
        v: 1,
        server: spec.id,
        outcome,
        ms: Date.now() - began,
      });
      return new Error(reason);
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: this.root,
        stdio: 'pipe',
      });
    } catch (error) {
      throw giveUp('failed', `${spec.command} could not start: ${error}`);
    }

    const spawnFailed = new Promise<never>((_, reject) =>
      child.once('error', (error) =>
        reject(new Error(`${spec.command} could not start: ${error.message}`)),
      ),
    );
    const server = new Server(child);
    const rootUri = pathToFileURL(this.root).href;

    try {
      await Promise.race([
        spawnFailed,
        server.request(
          'initialize',
          {
            processId: process.pid,
            rootUri,
            workspaceFolders: [{ uri: rootUri, name: 'repo' }],
            initializationOptions: spec.initializationOptions ?? {},
            capabilities: {
              textDocument: {
                synchronization: { didSave: false },
                publishDiagnostics: { versionSupport: true },
                hover: { contentFormat: ['plaintext', 'markdown'] },
                definition: { linkSupport: false },
                references: {},
                documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              },
              workspace: { symbol: {}, workspaceFolders: true },
            },
          },
          this.limits.startMs,
        ),
      ]);
    } catch (error) {
      server.kill();
      const timedOut = error instanceof TimeoutError;
      throw giveUp(
        timedOut ? 'timeout' : 'failed',
        timedOut
          ? `${spec.command} did not start within ${this.limits.startMs / 1000}s`
          : String((error as Error).message ?? error),
      );
    }

    server.notify('initialized', {});
    this.running.set(spec.id, server);
    this.report({
      v: 1,
      server: spec.id,
      outcome: 'started',
      ms: Date.now() - began,
    });
    return server;
  }

  /** Brings the server's copy of a file in line with the disk. */
  private sync(server: Server, spec: ServerSpec, path: string): string {
    const uri = pathToFileURL(path).href;
    const text = readFileSync(path, 'utf8');
    const open = server.open.get(uri);

    if (!open) {
      server.open.set(uri, { version: 1, text });
      server.notify('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: spec.languageId(extname(path).toLowerCase()),
          version: 1,
          text,
        },
      });
    } else if (open.text !== text) {
      open.version += 1;
      open.text = text;
      server.notify('textDocument/didChange', {
        textDocument: { uri, version: open.version },
        contentChanges: [{ text }],
      });
    }

    return uri;
  }

  private async ask(
    spec: ServerSpec,
    method: string,
    params: (uri: string) => unknown,
    path: string,
  ): Promise<unknown> {
    const server = await this.server(spec);
    const uri = this.sync(server, spec, path);
    try {
      const result = await server.request(
        method,
        params(uri),
        this.limits.requestMs,
      );
      server.timeouts = 0;
      return result;
    } catch (error) {
      if (error instanceof TimeoutError) {
        server.timeouts += 1;
        if (server.timeouts >= this.limits.timeouts) {
          server.kill();
          this.running.delete(spec.id);
          this.failed.set(
            spec.id,
            `${spec.command} stopped answering and was shut down`,
          );
          this.servers.delete(spec.id);
          this.report({ v: 1, server: spec.id, outcome: 'timeout', ms: 0 });
        }
      }
      throw error;
    }
  }

  /**
   * Where `symbol` sits on a 1-based line, as LSP's 0-based position. Models
   * count columns badly and lines well, so the tools take a line and a name.
   */
  locate(
    path: string,
    line: number,
    symbol?: string,
  ): { line: number; character: number } {
    const lines = readFileSync(path, 'utf8').split('\n');
    if (!Number.isInteger(line) || line < 1 || line > lines.length) {
      throw new Error(
        `${this.display(path)} has ${lines.length} lines; line ${line} is not one of them.`,
      );
    }
    if (!symbol) {
      const text = lines[line - 1];
      return {
        line: line - 1,
        character: text.length - text.trimStart().length,
      };
    }

    // The named line first, then the lines around it: a model's line number
    // is often one or two off after an edit.
    for (const offset of [0, 1, -1, 2, -2, 3, -3]) {
      const index = line - 1 + offset;
      const text = lines[index];
      if (text === undefined) {
        continue;
      }
      const word = new RegExp(
        `(^|[^\\w$])(${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![\\w$])`,
      ).exec(text);
      if (word) {
        return { line: index, character: word.index + word[1].length };
      }
    }

    throw new Error(
      `\`${symbol}\` is not on line ${line} of ${this.display(path)}, which reads: ${lines[line - 1].trim()}`,
    );
  }

  private sourceLine(uri: string, line: number): string {
    try {
      const path = fileURLToPath(uri);
      return (readFileSync(path, 'utf8').split('\n')[line] ?? '').trim();
    } catch {
      return '';
    }
  }

  private formatLocations(result: unknown, none: string): string {
    const raw = result == null ? [] : Array.isArray(result) ? result : [result];
    const locations = raw
      .map((item: Record<string, unknown>) => ({
        uri: String(item.uri ?? item.targetUri ?? ''),
        range: (item.range ?? item.targetSelectionRange) as Range | undefined,
      }))
      .filter((location) => location.uri && location.range);

    if (locations.length === 0) {
      return none;
    }

    const shown = locations
      .slice(0, this.limits.locations)
      .map(
        ({ uri, range }) =>
          `${this.display(uri)}:${range!.start.line + 1}:${range!.start.character + 1}  ${this.sourceLine(uri, range!.start.line)}`,
      );
    if (locations.length > shown.length) {
      shown.push(
        `… and ${locations.length - shown.length} more. Narrow the question, or use rg.`,
      );
    }
    return shown.join('\n');
  }

  async definition(path: string, line: number, symbol?: string) {
    const { spec, absolute } = this.target(path);
    const position = this.locate(absolute, line, symbol);
    return this.formatLocations(
      await this.ask(
        spec,
        'textDocument/definition',
        (uri) => ({ textDocument: { uri }, position }),
        absolute,
      ),
      'No definition found.',
    );
  }

  async references(path: string, line: number, symbol?: string) {
    const { spec, absolute } = this.target(path);
    const position = this.locate(absolute, line, symbol);
    return this.formatLocations(
      await this.ask(
        spec,
        'textDocument/references',
        (uri) => ({
          textDocument: { uri },
          position,
          context: { includeDeclaration: false },
        }),
        absolute,
      ),
      'No references found.',
    );
  }

  async hover(path: string, line: number, symbol?: string) {
    const { spec, absolute } = this.target(path);
    const position = this.locate(absolute, line, symbol);
    const result = (await this.ask(
      spec,
      'textDocument/hover',
      (uri) => ({ textDocument: { uri }, position }),
      absolute,
    )) as { contents?: unknown } | null;

    const text = hoverText(result?.contents).trim();
    if (!text) {
      return 'Nothing is known about that position.';
    }
    return text.length > this.limits.hoverChars
      ? `${text.slice(0, this.limits.hoverChars)}…`
      : text;
  }

  async diagnostics(path: string) {
    const { spec, absolute } = this.target(path);
    const server = await this.server(spec);
    const uri = pathToFileURL(absolute).href;
    const fresh = server.nextDiagnostics(
      uri,
      this.limits.diagnosticsMs,
      this.limits.settleMs,
    );
    this.sync(server, spec, absolute);
    // A file already open and unchanged is not re-checked, so there may be
    // nothing new to wait for; what the server last said still stands.
    if (!server.diagnostics.has(uri)) {
      await fresh;
    }
    const found = server.diagnostics.get(uri);
    if (!found) {
      return `The ${spec.id} server has not checked ${this.display(absolute)} yet. ${FALLBACK}`;
    }
    return (
      this.formatDiagnostics(found, this.limits.diagnostics) ||
      `No problems in ${this.display(absolute)}.`
    );
  }

  private formatDiagnostics(found: Diagnostic[], limit: number): string {
    const ordered = [...found].sort(
      (a, b) => (a.severity ?? 1) - (b.severity ?? 1),
    );
    const lines = ordered
      .slice(0, limit)
      .map(
        (d) =>
          `${d.range.start.line + 1}:${d.range.start.character + 1} ${SEVERITY[d.severity ?? 1] ?? 'error'}${d.code === undefined ? '' : ` ${d.source ? `${d.source} ` : ''}${d.code}`}: ${d.message.split('\n')[0]}`,
      );
    if (ordered.length > lines.length) {
      lines.push(`… and ${ordered.length - lines.length} more.`);
    }
    return lines.join('\n');
  }

  async symbols(options: { path?: string; query?: string }) {
    if (options.path) {
      const { spec, absolute } = this.target(options.path);
      const result = await this.ask(
        spec,
        'textDocument/documentSymbol',
        (uri) => ({ textDocument: { uri } }),
        absolute,
      );
      const lines: string[] = [];
      outline((result as SymbolNode[] | null) ?? [], 0, lines);
      if (lines.length === 0) {
        return `No symbols in ${this.display(absolute)}.`;
      }
      return capLines(lines, this.limits.symbols);
    }

    const query = options.query?.trim();
    if (!query) {
      throw new Error('Give a `path` for its outline, or a `query` to search.');
    }

    // Workspace symbols need a project loaded, which a server does when it
    // opens a file of it. Ask every language this checkout has a file in.
    const answers: string[] = [];
    for (const spec of this.specs) {
      const anchor = this.anyFile(spec);
      if (!anchor) {
        continue;
      }
      try {
        const result = (await this.ask(
          spec,
          'workspace/symbol',
          () => ({ query }),
          anchor,
        )) as SymbolNode[] | null;
        for (const item of result ?? []) {
          const location = item.location;
          if (!location?.uri || location.uri.includes('/node_modules/')) {
            continue;
          }
          answers.push(
            `${SYMBOL_KIND[item.kind] ?? 'symbol'} ${item.name}${item.containerName ? ` (in ${item.containerName})` : ''}  ${this.display(location.uri)}:${(location.range?.start.line ?? 0) + 1}`,
          );
        }
      } catch (error) {
        answers.push(`(${spec.id}: ${(error as Error).message})`);
      }
    }

    return answers.length
      ? capLines(answers, this.limits.symbols)
      : `No symbol matches \`${query}\`.`;
  }

  /** A file in the server's language, to anchor a workspace question. */
  private anyFile(spec: ServerSpec): string | undefined {
    const open = this.running.get(spec.id)?.open.keys().next().value;
    if (open) {
      return fileURLToPath(open);
    }
    const queue = [this.root];
    let seen = 0;
    while (queue.length && seen < 2_000) {
      const dir = queue.shift()!;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        seen += 1;
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
            queue.push(join(dir, entry.name));
          }
        } else if (
          spec.extensions.includes(extname(entry.name).toLowerCase()) &&
          !entry.name.endsWith('.d.ts')
        ) {
          return join(dir, entry.name);
        }
      }
    }
    return undefined;
  }

  private target(path: string): { spec: ServerSpec; absolute: string } {
    const absolute = this.resolvePath(path);
    const spec = this.specFor(absolute);
    if (!spec) {
      throw new Error(
        `No language server covers ${extname(absolute) || 'that file'}; the guest has them for TypeScript, JavaScript and Python. ${FALLBACK}`,
      );
    }
    return { spec, absolute };
  }

  /**
   * After the agent changed a file: the errors in it now, or `null` when
   * there is nothing worth saying. Never starts a server that has failed,
   * and never waits past the limits.
   */
  async afterEdit(path: string): Promise<string | null> {
    let absolute: string;
    try {
      absolute = this.resolvePath(path);
    } catch {
      return null;
    }
    const spec = this.specFor(absolute);
    if (!spec || this.failed.has(spec.id)) {
      return null;
    }

    let server: Server;
    try {
      server = await this.server(spec);
    } catch {
      return null;
    }

    const uri = pathToFileURL(absolute).href;
    const before = (server.diagnostics.get(uri) ?? []).filter(isError).length;
    const fresh = server.nextDiagnostics(
      uri,
      this.limits.diagnosticsMs,
      this.limits.settleMs,
    );
    try {
      this.sync(server, spec, absolute);
    } catch {
      return null;
    }
    if (!(await fresh)) {
      return null;
    }

    const errors = (server.diagnostics.get(uri) ?? []).filter(isError);
    if (errors.length === 0) {
      return before > 0 ? `No errors left in ${this.display(absolute)}.` : null;
    }
    return [
      `${spec.id} reports ${errors.length} error${errors.length === 1 ? '' : 's'} in ${this.display(absolute)} after this change:`,
      this.formatDiagnostics(errors, this.limits.editErrors),
    ].join('\n');
  }

  shutdown() {
    for (const started of this.servers.values()) {
      started.then((server) => server.kill()).catch((): void => undefined);
    }
    this.servers.clear();
    this.running.clear();
  }
}

/** Why a question could not be answered, said so the agent moves on. */
export function codeIntelFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /rg|checks/.test(message) ? message : `${message}. ${FALLBACK}`;
}

const SEVERITY: Record<number, string> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
};

const isError = (d: Diagnostic) => (d.severity ?? 1) === 1;

// LSP's SymbolKind, 1-based.
const SYMBOL_KIND: Record<number, string> = Object.fromEntries(
  [
    'file',
    'module',
    'namespace',
    'package',
    'class',
    'method',
    'property',
    'field',
    'constructor',
    'enum',
    'interface',
    'function',
    'variable',
    'constant',
    'string',
    'number',
    'boolean',
    'array',
    'object',
    'key',
    'null',
    'enum member',
    'struct',
    'event',
    'operator',
    'type parameter',
  ].map((name, index) => [index + 1, name]),
);

interface SymbolNode {
  name: string;
  kind: number;
  containerName?: string;
  range?: Range;
  selectionRange?: Range;
  location?: { uri: string; range?: Range };
  children?: SymbolNode[];
}

function outline(nodes: SymbolNode[], depth: number, lines: string[]) {
  for (const node of nodes) {
    const range = node.selectionRange ?? node.range ?? node.location?.range;
    lines.push(
      `${'  '.repeat(depth)}${SYMBOL_KIND[node.kind] ?? 'symbol'} ${node.name}${range ? `  :${range.start.line + 1}` : ''}`,
    );
    if (node.children?.length) {
      outline(node.children, depth + 1, lines);
    }
  }
}

function capLines(lines: string[], limit: number): string {
  return lines.length > limit
    ? [...lines.slice(0, limit), `… and ${lines.length - limit} more.`].join(
        '\n',
      )
    : lines.join('\n');
}

function hoverText(contents: unknown): string {
  if (!contents) {
    return '';
  }
  if (typeof contents === 'string') {
    return contents;
  }
  if (Array.isArray(contents)) {
    return contents.map(hoverText).filter(Boolean).join('\n\n');
  }
  const value = (contents as { value?: unknown }).value;
  return typeof value === 'string' ? value : '';
}

// -------------------------------------------------------------------- tools

const position = {
  path: {
    type: 'string',
    description: 'The file, relative to the repository root.',
  },
  line: { type: 'integer', minimum: 1, description: 'The 1-based line.' },
  symbol: {
    type: 'string',
    description:
      'The name on that line to ask about. Without it, the start of the line.',
  },
};

const answer = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  details: {},
});

/**
 * The code tools, and the type errors appended to every edit of a file a
 * server covers. Answers that fail are answers too: the agent is told what
 * to do instead, and the run carries on.
 */
export function registerCodeTools(pi: PiApi, root: string): CodeIntel | null {
  if (!pi.registerTool) {
    return null;
  }

  const intel = new CodeIntel(root, (record) => {
    try {
      pi.appendEntry(LANGUAGE_SERVER_ENTRY, record);
    } catch {
      // Telemetry is bookkeeping.
    }
  });
  const guarded =
    (ask: (params: Record<string, unknown>) => Promise<string>) =>
    async (_id: string, params: Record<string, unknown>) => {
      try {
        return answer(await ask(params));
      } catch (error) {
        return answer(codeIntelFailure(error));
      }
    };
  const at = (params: Record<string, unknown>) =>
    [
      String(params.path ?? ''),
      Number(params.line),
      typeof params.symbol === 'string' && params.symbol.trim()
        ? params.symbol.trim()
        : undefined,
    ] as const;
  const schema = {
    type: 'object',
    properties: position,
    required: ['path', 'line'],
    additionalProperties: false,
  };

  pi.registerTool({
    name: 'code_definition',
    label: 'Go to definition',
    description:
      'Where a name is defined, from the language server: follows imports, re-exports and types the way grep cannot. TypeScript, JavaScript and Python.',
    promptSnippet: 'code_definition: where a name on a line is defined',
    parameters: schema,
    execute: guarded((params) => intel.definition(...at(params))),
  });

  pi.registerTool({
    name: 'code_references',
    label: 'Find references',
    description:
      'Every use of a name across the project, from the language server: the real callers, not every string that matches. Use it before changing a signature.',
    promptSnippet: 'code_references: every use of a name, before you change it',
    parameters: schema,
    execute: guarded((params) => intel.references(...at(params))),
  });

  pi.registerTool({
    name: 'code_hover',
    label: 'Type of a name',
    description:
      'The type and documentation of a name, as the language server infers it.',
    promptSnippet: 'code_hover: the inferred type of a name',
    parameters: schema,
    execute: guarded((params) => intel.hover(...at(params))),
  });

  pi.registerTool({
    name: 'code_diagnostics',
    label: 'Problems in a file',
    description:
      "The language server's errors and warnings for one file. Errors in a file you edit are also shown after each edit; for the whole project, run its checks.",
    promptSnippet: 'code_diagnostics: type errors and warnings in a file',
    parameters: {
      type: 'object',
      properties: { path: position.path },
      required: ['path'],
      additionalProperties: false,
    },
    execute: guarded((params) => intel.diagnostics(String(params.path ?? ''))),
  });

  pi.registerTool({
    name: 'code_symbols',
    label: 'Symbols',
    description:
      'With `path`: the outline of a file (classes, functions, methods, with lines). With `query`: the declarations across the project whose names match.',
    promptSnippet:
      'code_symbols: a file outline, or find a declaration by name',
    parameters: {
      type: 'object',
      properties: {
        path: position.path,
        query: {
          type: 'string',
          description: 'A name, or part of one, to find declared anywhere.',
        },
      },
      additionalProperties: false,
    },
    execute: guarded((params) =>
      intel.symbols({
        path: typeof params.path === 'string' ? params.path : undefined,
        query: typeof params.query === 'string' ? params.query : undefined,
      }),
    ),
  });

  pi.on(
    'tool_result',
    async (event: {
      toolName?: string;
      input?: Record<string, unknown>;
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    }) => {
      if (
        event.isError ||
        (event.toolName !== 'write' && event.toolName !== 'edit') ||
        typeof event.input?.path !== 'string'
      ) {
        return undefined;
      }
      const report = await intel
        .afterEdit(event.input.path)
        .catch((): null => null);
      if (!report) {
        return undefined;
      }
      return {
        content: [...(event.content ?? []), { type: 'text', text: report }],
      };
    },
  );

  pi.on('session_shutdown', () => intel.shutdown());
  process.once('exit', () => intel.shutdown());

  return intel;
}

/**
 * The omp (oh-my-pi) side of `vantik connect`: one `omp --mode rpc` process,
 * driven over JSON lines on stdin and stdout.
 *
 * The driver knows the framing and the commands it needs (`negotiate_protocol`,
 * `get_state`, `prompt`, `abort`, `get_entries`). It does not know about
 * worktrees, sockets or Vantik, and it takes the child process as a parameter,
 * so a test drives it with a fake.
 */

/** The RPC protocol version the driver speaks. omp 18.8.6 supports 1 and 2. */
export const OMP_RPC_PROTOCOL_VERSION = 2;

/** The slice of a child process the driver uses. */
export interface OmpChildLike {
  /** The process id, when the child started. */
  pid?: number;
  stdin: { write(chunk: string): unknown };
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown };
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown };
  on(
    event: 'exit',
    cb: (code: number | null, signal: string | null) => void,
  ): unknown;
  on(event: 'error', cb: (error: Error) => void): unknown;
  kill(signal?: string): unknown;
}

/** Splits a byte stream into complete lines. A partial last line waits. */
export class LineSplitter {
  private rest = '';

  push(chunk: string): string[] {
    this.rest += chunk;
    const lines = this.rest.split('\n');
    this.rest = lines.pop() ?? '';
    return lines.map((line) => line.replace(/\r$/, '')).filter((l) => l !== '');
  }

  /** The unterminated tail, once the stream has ended. */
  flush(): string[] {
    const tail = this.rest.trim();
    this.rest = '';
    return tail ? [tail] : [];
  }
}

export interface RpcResponse {
  id: string;
  type: 'response';
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export type OmpEvent = { type: string } & Record<string, unknown>;

/** Parses one line of omp's stdout. Anything that is not a JSON object is null. */
export function parseRpcLine(line: string): OmpEvent | RpcResponse | null {
  try {
    const value = JSON.parse(line) as unknown;
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as { type?: unknown }).type === 'string'
    ) {
      return value as OmpEvent;
    }
  } catch {
    // Not JSON: omp printed a plain line. It is not an event.
  }
  return null;
}

/**
 * Events that carry no run information. They are not forwarded: the server
 * would only store noise.
 */
const NOISE_EVENTS = new Set([
  'ready',
  'extension_ui_request',
  'available_commands_update',
]);

export interface OmpExit {
  code: number | null;
  signal: string | null;
  stderrTail: string;
  error: Error | null;
}

export interface AssistantMessage {
  text: string;
  stopReason: string | null;
  errorMessage: string | null;
}

/** Text of an omp message's content, which is a string or a list of blocks. */
export function messageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((block) =>
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : '',
    )
    .join('');
}

const STDERR_TAIL_BYTES = 4000;

interface Pending {
  resolve(response: RpcResponse): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class OmpDriver {
  readonly exited: Promise<OmpExit>;

  private readonly splitter = new LineSplitter();
  private readonly pending = new Map<string, Pending>();
  private readonly listeners: Array<(event: OmpEvent) => void> = [];
  private readonly uiListeners: Array<(request: OmpEvent) => void> = [];
  private readonly agentEndWaiters: Array<{
    resolve(): void;
    reject(error: Error): void;
  }> = [];
  private agentStarts = 0;
  private running = false;
  private nextId = 1;
  private stderr = '';
  private done: OmpExit | null = null;
  private lastAssistant: AssistantMessage | null = null;
  private entryCursor: string | undefined;
  private polling: Promise<unknown[]> = Promise.resolve([]);

  constructor(
    private readonly child: OmpChildLike,
    private readonly options: { requestTimeoutMs?: number } = {},
  ) {
    let spawnError: Error | null = null;

    this.exited = new Promise<OmpExit>((resolve) => {
      child.on('error', (error) => {
        spawnError = error;
      });
      child.on('exit', (code, signal) => {
        for (const line of this.splitter.flush()) {
          this.handleLine(line);
        }
        const exit: OmpExit = {
          code,
          signal,
          stderrTail: this.stderr.trim(),
          error: spawnError,
        };
        this.done = exit;
        const reason = new Error(
          spawnError?.message ??
            `omp exited (${signal ?? `code ${String(code)}`})${
              exit.stderrTail ? `: ${exit.stderrTail.slice(-500)}` : ''
            }`,
        );
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(reason);
        }
        this.pending.clear();
        for (const waiter of this.agentEndWaiters.splice(0)) {
          waiter.reject(reason);
        }
        resolve(exit);
      });
    });

    child.stdout.on('data', (chunk) => {
      for (const line of this.splitter.push(String(chunk))) {
        this.handleLine(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-STDERR_TAIL_BYTES);
    });
  }

  /** Called with every event that carries run information, in order. */
  onEvent(listener: (event: OmpEvent) => void) {
    this.listeners.push(listener);
  }

  /**
   * Called with every `extension_ui_request`. These are not run events and
   * are not passed to `onEvent`: the dialogs among them wait for a reply.
   */
  onUiRequest(listener: (request: OmpEvent) => void) {
    this.uiListeners.push(listener);
  }

  /** Replies to a dialog: an `extension_ui_response` with the dialog's id. */
  respondUi(id: string, body: Record<string, unknown>) {
    if (this.done) {
      return;
    }
    this.child.stdin.write(
      `${JSON.stringify({ ...body, type: 'extension_ui_response', id })}\n`,
    );
  }

  get hasExited() {
    return this.done !== null;
  }

  get stderrTail() {
    return this.stderr.trim();
  }

  /** The agent's last assistant message, or null before there is one. */
  get lastAssistantMessage(): AssistantMessage | null {
    return this.lastAssistant;
  }

  private handleLine(line: string) {
    const parsed = parseRpcLine(line);
    if (!parsed) {
      return;
    }

    if (parsed.type === 'response') {
      const response = parsed as RpcResponse;
      const entry = this.pending.get(response.id);
      if (entry) {
        this.pending.delete(response.id);
        clearTimeout(entry.timer);
        entry.resolve(response);
      }
      return;
    }

    const event = parsed as OmpEvent;
    if (event.type === 'agent_start') {
      this.agentStarts += 1;
      this.running = true;
    } else if (event.type === 'agent_end') {
      this.running = false;
    }
    this.trackAssistant(event);
    if (event.type === 'extension_ui_request') {
      for (const listener of this.uiListeners) {
        listener(event);
      }
    }
    if (!NOISE_EVENTS.has(event.type)) {
      for (const listener of this.listeners) {
        listener(event);
      }
    }
    if (event.type === 'agent_end') {
      for (const waiter of this.agentEndWaiters.splice(0)) {
        waiter.resolve();
      }
    }
  }

  private trackAssistant(event: OmpEvent) {
    const record = (message: unknown) => {
      if (
        message &&
        typeof message === 'object' &&
        (message as { role?: unknown }).role === 'assistant'
      ) {
        const m = message as Record<string, unknown>;
        this.lastAssistant = {
          text: messageText(m.content),
          stopReason: typeof m.stopReason === 'string' ? m.stopReason : null,
          errorMessage:
            typeof m.errorMessage === 'string' ? m.errorMessage : null,
        };
      }
    };

    if (event.type === 'message_end') {
      record(event.message);
    } else if (event.type === 'agent_end' && Array.isArray(event.messages)) {
      // The messages of the whole turn; the last assistant one wins.
      for (const message of event.messages) {
        record(message);
      }
    }
  }

  /** Sends one command and resolves with its response. */
  request(
    command: Record<string, unknown> & { type: string },
    options: { timeoutMs?: number | null } = {},
  ): Promise<RpcResponse> {
    if (this.done) {
      return Promise.reject(new Error('omp has exited.'));
    }

    const id = String(this.nextId++);
    const timeoutMs =
      options.timeoutMs === undefined
        ? (this.options.requestTimeoutMs ?? 30_000)
        : options.timeoutMs;

    return new Promise<RpcResponse>((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`omp did not answer ${command.type} in time.`));
            }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  private async ok(
    command: Record<string, unknown> & { type: string },
    options?: { timeoutMs?: number | null },
  ): Promise<unknown> {
    const response = await this.request(command, options);
    if (!response.success) {
      throw new Error(
        `omp refused ${command.type}: ${response.error ?? 'no reason given'}`,
      );
    }
    return response.data;
  }

  async negotiate(): Promise<void> {
    await this.ok({
      type: 'negotiate_protocol',
      protocolVersion: OMP_RPC_PROTOCOL_VERSION,
    });
  }

  /**
   * Opts in to `ask` dialogs. Without it omp does not send `ask` requests to
   * the client. Call it after `negotiate`.
   */
  async setAskDialog(enabled: boolean): Promise<void> {
    await this.ok({ type: 'set_ask_dialog', enabled });
  }

  async getState(): Promise<{ sessionId: string; sessionFile: string }> {
    const state = (await this.ok({ type: 'get_state' })) as Record<
      string,
      unknown
    >;
    return {
      sessionId: String(state.sessionId ?? ''),
      sessionFile: String(state.sessionFile ?? ''),
    };
  }

  /**
   * Sends the first prompt. The returned promise settles when omp has taken or
   * refused the prompt, which can be before the agent is done; use
   * `waitForAgentEnd` for that.
   */
  async prompt(message: string): Promise<void> {
    await this.ok({ type: 'prompt', message }, { timeoutMs: null });
  }

  async abort(): Promise<void> {
    await this.ok({ type: 'abort' }, { timeoutMs: 10_000 });
  }

  /** Resolves at the next `agent_end`, rejects if omp exits first. */
  waitForAgentEnd(): Promise<void> {
    if (this.done) {
      return Promise.reject(new Error('omp has exited.'));
    }
    return new Promise((resolve, reject) => {
      this.agentEndWaiters.push({ resolve, reject });
    });
  }

  /**
   * Resolves when the agent is done, not just when a turn ended. A handler in
   * an extension can start another turn from `agent_end` (the Vantik
   * extension sends a reminder to run the checks), so after each `agent_end`
   * this waits a settle window. A new `agent_start` in it restarts the wait.
   * Otherwise it asks `get_state`, whose `isSettled` is true only when omp is
   * not streaming and has nothing queued or pending. Rejects if omp exits.
   */
  async waitForIdle(
    options: { settleMs?: number; pollMs?: number } = {},
  ): Promise<void> {
    const settleMs = options.settleMs ?? 1500;
    const pollMs = options.pollMs ?? 300;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));

    await this.waitForAgentEnd();
    let window = settleMs;
    for (;;) {
      const starts = this.agentStarts;
      await sleep(window);
      if (this.hasExited) {
        throw new Error('omp has exited.');
      }
      if (this.agentStarts !== starts) {
        if (this.running) {
          await this.waitForAgentEnd();
        }
        window = settleMs;
        continue;
      }
      const response = await this.request({ type: 'get_state' });
      const data = (response.data ?? {}) as { isSettled?: unknown };
      if (response.success && data.isSettled === true) {
        return;
      }
      window = pollMs;
    }
  }

  /**
   * The session entries written since the last call, custom ones only: the
   * entries the Vantik extension wrote with `appendEntry`. omp never emits
   * `entry_appended`, so this is how they leave the session. Calls queue, so
   * two polls never read from the same cursor.
   */
  pollEntries(): Promise<unknown[]> {
    const next = this.polling.then(async () => {
      const data = (await this.ok({
        type: 'get_entries',
        ...(this.entryCursor === undefined ? {} : { since: this.entryCursor }),
      })) as { entries?: Array<{ id?: unknown; type?: unknown }> };

      const entries = Array.isArray(data.entries) ? data.entries : [];
      const last = entries[entries.length - 1];
      if (last && typeof last.id === 'string') {
        this.entryCursor = last.id;
      }
      return entries.filter((entry) => entry.type === 'custom');
    });
    this.polling = next.catch(() => []);
    return next;
  }

  kill(signal: string = 'SIGTERM') {
    if (!this.done) {
      this.child.kill(signal);
    }
  }
}

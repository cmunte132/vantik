import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  SANDBOX_HOST_MAX_WAIT_MS,
  type SandboxAvailability,
  type SandboxExecOptions,
  type SandboxExecResult,
  type SandboxHandle,
  type SandboxHostCreated,
  type SandboxHostExecStarted,
  type SandboxHostExecStatus,
  type SandboxHostModelCalls,
  type SandboxHostSandbox,
  type SandboxHostStream,
  type SandboxRuntime,
  type SandboxSpec,
  type SandboxTier,
} from '@vantikhq/types';

import { LoggerService } from 'modules/logger/logger.service';

export interface SandboxHostOptions {
  url?: string;
  token?: string;
  fetch?: typeof fetch;
  /** Between keepalives. The sandbox host disposes of a sandbox left idle. */
  keepaliveMs?: number;
  /** Between two tries of a poll that did not reach the sandbox host. */
  retryDelayMs?: number;
}

export const SANDBOX_HOST_OPTIONS = 'SANDBOX_HOST_OPTIONS';

/** Polls that may fail in a row before a command counts as lost. */
const POLL_RETRIES = 5;

/**
 * The sandbox runtime, reached over HTTP in the sandbox host.
 *
 * The server does not start VMs. A microVM needs QEMU and hardware
 * virtualisation, and the server often runs where it has neither, such as a
 * container on macOS. The sandbox host (`apps/sandbox-host`) runs where the
 * hypervisor is, and this class is the whole of the server's side of it.
 *
 * Configured by `SANDBOX_HOST_URL` and `SANDBOX_HOST_TOKEN`. With either unset,
 * or the sandbox host out of reach, hosted execution is unavailable and says
 * why. It is never replaced by something weaker.
 */
@Injectable()
export class RemoteSandboxRuntime implements SandboxRuntime {
  readonly name = 'sandbox-host';

  private readonly logger = new LoggerService('RemoteSandboxRuntime');
  private readonly url: string;
  private readonly token: string;
  private readonly fetch: typeof fetch;
  private readonly keepaliveMs: number;
  private readonly retryDelayMs: number;

  constructor(
    @Optional() @Inject(SANDBOX_HOST_OPTIONS) options: SandboxHostOptions = {},
  ) {
    this.url = (options.url ?? process.env.SANDBOX_HOST_URL ?? '').replace(
      /\/+$/,
      '',
    );
    this.token = options.token ?? process.env.SANDBOX_HOST_TOKEN ?? '';
    this.fetch = options.fetch ?? fetch;
    this.keepaliveMs = options.keepaliveMs ?? 60_000;
    this.retryDelayMs = options.retryDelayMs ?? 2_000;
  }

  async availability(): Promise<SandboxAvailability> {
    if (!this.url || !this.token) {
      return {
        available: false,
        reason:
          'No sandbox host is configured, so this server cannot start a ' +
          'sandbox. Run the sandbox host (apps/sandbox-host) where QEMU and ' +
          'hardware virtualisation are available, and set SANDBOX_HOST_URL and ' +
          'SANDBOX_HOST_TOKEN for the server.',
      };
    }

    try {
      return await this.request<SandboxAvailability>(
        'GET',
        '/v1/availability',
        {
          timeoutMs: 5_000,
        },
      );
    } catch (error) {
      return { available: false, reason: this.unreachable(error) };
    }
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const availability = await this.availability();

    if (!availability.available) {
      // Refused, never downgraded: a weaker sandbox nobody was told about
      // makes the threat model on paper stop matching production.
      throw new Error(availability.reason);
    }

    const created = await this.request<SandboxHostCreated>(
      'POST',
      '/v1/sandboxes',
      {
        json: spec,
        // A cold boot of the guest, plus seeding its files.
        timeoutMs: 5 * 60_000,
      },
    );

    return new RemoteSandboxHandle(this, created.id, created.tier, spec);
  }

  /** The sandboxes the sandbox host holds, for boot-time cleanup. */
  list(): Promise<SandboxHostSandbox[]> {
    return this.request<SandboxHostSandbox[]>('GET', '/v1/sandboxes', {
      timeoutMs: 10_000,
    });
  }

  /** Never throws: disposal runs on every path out of a run. */
  async dispose(id: string): Promise<void> {
    try {
      await this.request('DELETE', `/v1/sandboxes/${encodeURIComponent(id)}`, {
        timeoutMs: 60_000,
      });
    } catch (error) {
      // The sandbox host disposes of it anyway once its keepalives stop.
      this.logger.error({
        message: `Could not dispose of sandbox ${id}: ${this.unreachable(error)}`,
        where: 'RemoteSandboxRuntime.dispose',
      });
    }
  }

  /** @internal */
  async exec(
    id: string,
    command: string,
    timeoutMs: number,
    onStdout?: SandboxExecOptions['onStdout'],
  ): Promise<SandboxExecResult> {
    const base = `/v1/sandboxes/${encodeURIComponent(id)}/exec`;
    const { execId } = await this.request<SandboxHostExecStarted>(
      'POST',
      base,
      { json: { command, timeoutMs }, timeoutMs: 30_000 },
    );

    // The sandbox host stops the command at `timeoutMs`. This is only a guard
    // against a sandbox host that went quiet without saying so.
    const giveUpAt = Date.now() + timeoutMs + 2 * 60_000;
    let failures = 0;
    // The offset of the next stdout to collect. Only a caller that reads the
    // output as it comes asks for it; the others get the result alone.
    let since = 0;

    for (;;) {
      let status: SandboxHostExecStatus;

      try {
        status = await this.request<SandboxHostExecStatus>(
          'GET',
          `${base}/${encodeURIComponent(execId)}?waitMs=${SANDBOX_HOST_MAX_WAIT_MS}${
            onStdout ? `&since=${since}` : ''
          }`,
          { timeoutMs: SANDBOX_HOST_MAX_WAIT_MS + 15_000 },
        );
        failures = 0;
      } catch (error) {
        // A blip between the two processes must not end a run that is still
        // working. A 404 is not a blip: the sandbox or the command is gone.
        if (error instanceof SandboxHostError && error.status === 404) {
          throw error;
        }
        if (++failures > POLL_RETRIES) {
          throw new Error(
            `Lost the command in sandbox ${id}: ${this.unreachable(error)}`,
          );
        }
        await delay(this.retryDelayMs);
        continue;
      }

      if (onStdout && status.stream) {
        since = this.takeStream(status.stream, since, onStdout);
      }

      if (status.done) {
        if ('error' in status) {
          throw new Error(status.error);
        }
        return status.result;
      }

      if (Date.now() > giveUpAt) {
        throw new Error(
          `The command in sandbox ${id} did not finish in ${Math.round(timeoutMs / 1000)}s.`,
        );
      }
    }
  }

  /**
   * Gives the caller the new part of a stream answer, and returns the offset
   * to ask from next. Output the sandbox host had to drop is marked with an
   * LF, so a reader that splits on lines drops the broken line rather than
   * joining two halves.
   */
  private takeStream(
    stream: SandboxHostStream,
    since: number,
    onStdout: (chunk: string) => void,
  ): number {
    const text = stream.text.slice(Math.max(since - stream.from, 0));

    if (text) {
      onStdout(stream.from > since ? `\n${text}` : text);
    }

    return Math.max(since, stream.from + stream.text.length);
  }

  /**
   * @internal
   *
   * A sandbox host from before metering answers 404 for the route, and its
   * calls are then simply unmetered: the run is billed by what the harness
   * reported, as it was.
   */
  async modelCalls(id: string, since: number): Promise<SandboxHostModelCalls> {
    try {
      return await this.request<SandboxHostModelCalls>(
        'GET',
        `/v1/sandboxes/${encodeURIComponent(id)}/model-calls?since=${since}`,
        { timeoutMs: 30_000 },
      );
    } catch (error) {
      if (error instanceof SandboxHostError && error.status === 404) {
        return { calls: [], next: since };
      }
      throw error;
    }
  }

  /** @internal */
  async readFile(id: string, path: string): Promise<string> {
    return this.request<string>('GET', this.filePath(id, path), {
      text: true,
      timeoutMs: 60_000,
    });
  }

  /** @internal */
  async writeFile(id: string, path: string, contents: string): Promise<void> {
    await this.request('PUT', this.filePath(id, path), {
      body: contents,
      // A checkout goes up as one file of up to a few hundred megabytes.
      timeoutMs: 10 * 60_000,
    });
  }

  /** @internal */
  keepalive(id: string): () => void {
    const timer = setInterval(() => {
      void this.request(
        'POST',
        `/v1/sandboxes/${encodeURIComponent(id)}/keepalive`,
        { timeoutMs: 10_000 },
      ).catch((): undefined => undefined);
    }, this.keepaliveMs);
    timer.unref();

    return () => clearInterval(timer);
  }

  private filePath(id: string, path: string): string {
    return `/v1/sandboxes/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`;
  }

  private async request<T = void>(
    method: string,
    path: string,
    options: {
      json?: unknown;
      body?: string;
      text?: boolean;
      timeoutMs: number;
    },
  ): Promise<T> {
    const response = await this.fetch(`${this.url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(options.json !== undefined
          ? { 'content-type': 'application/json' }
          : options.body !== undefined
            ? { 'content-type': 'text/plain; charset=utf-8' }
            : {}),
      },
      body:
        options.json !== undefined
          ? JSON.stringify(options.json)
          : options.body,
      signal: AbortSignal.timeout(options.timeoutMs),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new SandboxHostError(
        response.status,
        body.error ?? `The sandbox host answered ${response.status}.`,
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (options.text ? await response.text() : await response.json()) as T;
  }

  private unreachable(error: unknown): string {
    if (error instanceof SandboxHostError && error.status === 401) {
      return (
        'The sandbox host refused the server’s token. Set the same ' +
        'SANDBOX_HOST_TOKEN for the server and the sandbox host.'
      );
    }

    if (error instanceof SandboxHostError) {
      return error.message;
    }

    const message =
      error instanceof Error
        ? `${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ''}`
        : String(error);

    return `The sandbox host at ${this.url} did not answer (${message}). Start it, or check SANDBOX_HOST_URL.`;
  }
}

export class SandboxHostError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

class RemoteSandboxHandle implements SandboxHandle {
  private disposed = false;
  private readonly stopKeepalive: () => void;

  constructor(
    private readonly runtime: RemoteSandboxRuntime,
    readonly id: string,
    readonly tier: SandboxTier,
    private readonly spec: SandboxSpec,
  ) {
    this.stopKeepalive = runtime.keepalive(id);
  }

  exec(
    command: string,
    options: SandboxExecOptions = {},
  ): Promise<SandboxExecResult> {
    return this.runtime.exec(
      this.id,
      command,
      options.timeoutMs ?? this.spec.limits.maxDurationMs,
      options.onStdout,
    );
  }

  modelCalls(since: number): Promise<SandboxHostModelCalls> {
    return this.runtime.modelCalls(this.id, since);
  }

  readFile(path: string): Promise<string> {
    return this.runtime.readFile(this.id, path);
  }

  writeFile(path: string, contents: string): Promise<void> {
    return this.runtime.writeFile(this.id, path, contents);
  }

  /** Idempotent, and never throws. */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stopKeepalive();
    await this.runtime.dispose(this.id);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

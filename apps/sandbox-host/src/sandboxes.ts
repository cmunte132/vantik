import type {
  SandboxHandle,
  SandboxHostExecStatus,
  SandboxHostModelCalls,
  SandboxHostSandbox,
  SandboxRuntime,
  SandboxSpec,
  SandboxTier,
} from "@vantikhq/types";

import { randomUUID } from "node:crypto";

import { log } from "./log";

export class NotFoundError extends Error {}

export interface LifetimeOptions {
  /**
   * How long a sandbox may go without a request before it is disposed. The
   * server sends a keepalive while it holds a sandbox, so only a sandbox whose
   * server stopped (a crash, a restart, a lost network) goes this long.
   */
  idleMs: number;
  /** Time past the run's own `maxDurationMs` before the sandbox is disposed. */
  graceMs: number;
  now?: () => number;
}

interface Exec {
  status: SandboxHostExecStatus;
  finished: Promise<void>;
  /** The stdout that no poll has acknowledged yet. */
  text: string;
  /** The offset of `text` in the command's stdout. */
  base: number;
  /** Polls that wait for output, woken on each chunk. */
  waiters: Set<() => void>;
}

/**
 * The most unacknowledged stdout kept for one command. A server that stops
 * polling must not make the sandbox host hold everything a long command
 * writes, so past this the oldest output is dropped.
 */
export const MAX_STREAM_CHARS = 16 * 1024 * 1024;

/**
 * How long a poll waits for more output after the first new output arrives.
 * The harness writes many small lines at once, and one answer for all of them
 * costs less than one answer for each.
 */
const BATCH_MS = 250;

interface Entry {
  id: string;
  runId: string;
  tier: SandboxTier;
  handle: SandboxHandle;
  createdAt: number;
  lastTouchedAt: number;
  deadlineAt: number;
  execs: Map<string, Exec>;
}

/**
 * The sandboxes this host is running, and how long each may live.
 *
 * The lifetime belongs here, not to the server. The server can stop at any
 * time, and a VM with nobody to dispose of it would hold its memory, and the
 * model key in its secret hooks, until the host restarts. So each sandbox has
 * a hard deadline from its own spec, and an idle limit that a live server
 * resets with every request.
 */
export class Sandboxes {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(
    private readonly runtime: SandboxRuntime,
    private readonly options: LifetimeOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  async create(spec: SandboxSpec): Promise<{ id: string; tier: SandboxTier }> {
    const handle = await this.runtime.create(spec);
    const id = randomUUID();
    const now = this.now();

    this.entries.set(id, {
      id,
      runId: spec.runId,
      tier: handle.tier,
      handle,
      createdAt: now,
      lastTouchedAt: now,
      deadlineAt: now + spec.limits.maxDurationMs + this.options.graceMs,
      execs: new Map(),
    });

    log.info("Started a sandbox", { sandboxId: id, runId: spec.runId });

    return { id, tier: handle.tier };
  }

  list(): SandboxHostSandbox[] {
    return [...this.entries.values()].map((entry) => ({
      id: entry.id,
      runId: entry.runId,
      createdAt: new Date(entry.createdAt).toISOString(),
      lastTouchedAt: new Date(entry.lastTouchedAt).toISOString(),
      deadlineAt: new Date(entry.deadlineAt).toISOString(),
    }));
  }

  /** Marks the sandbox as still wanted. */
  touch(id: string): void {
    this.entry(id);
  }

  /**
   * Starts a command and returns at once.
   *
   * The harness runs for most of a run's budget, often tens of minutes. One
   * HTTP request that long breaks on any proxy, restart or network blip, so the
   * caller polls for the result instead.
   */
  startExec(id: string, command: string, timeoutMs?: number): string {
    const entry = this.entry(id);
    const execId = randomUUID();
    const remaining = Math.max(entry.deadlineAt - this.now(), 1);

    const exec: Exec = {
      status: { done: false },
      finished: Promise.resolve(),
      text: "",
      base: 0,
      waiters: new Set(),
    };
    const wake = () => {
      for (const waiter of exec.waiters) {
        waiter();
      }
    };
    const onStdout = (chunk: string) => {
      exec.text += chunk;

      if (exec.text.length > MAX_STREAM_CHARS) {
        const dropped = exec.text.length - MAX_STREAM_CHARS;
        exec.text = exec.text.slice(dropped);
        exec.base += dropped;
      }

      wake();
    };

    exec.finished = entry.handle
      .exec(command, {
        timeoutMs: Math.min(timeoutMs ?? remaining, remaining),
        onStdout,
      })
      .then(
        (result) => {
          exec.status = { done: true, result };
        },
        (error: unknown) => {
          exec.status = {
            done: true,
            error: error instanceof Error ? error.message : String(error),
          };
        },
      )
      .finally(wake);

    entry.execs.set(execId, exec);

    return execId;
  }

  /**
   * Where a command is, waiting up to `waitMs` for it to finish. A finished
   * command is given out once and then forgotten.
   *
   * With `since`, the answer also carries the stdout from that offset, and it
   * comes as soon as there is new output. Output before `since` is
   * acknowledged and dropped; output after it is kept until a later poll
   * acknowledges it, so a poll whose answer was lost can be sent again.
   */
  async waitExec(
    id: string,
    execId: string,
    waitMs: number,
    since?: number,
  ): Promise<SandboxHostExecStatus> {
    const entry = this.entry(id);
    const exec = entry.execs.get(execId);

    if (!exec) {
      throw new NotFoundError(`No command ${execId} in sandbox ${id}`);
    }

    const streaming = since !== undefined;

    if (streaming && since > exec.base) {
      const acknowledged = Math.min(since - exec.base, exec.text.length);
      exec.text = exec.text.slice(acknowledged);
      exec.base += acknowledged;
    }

    if (!exec.status.done && waitMs > 0 && !(streaming && exec.text)) {
      await this.waitForChange(exec, waitMs, streaming);
    }

    const status: SandboxHostExecStatus = streaming
      ? { ...exec.status, stream: { from: exec.base, text: exec.text } }
      : exec.status;

    if (exec.status.done) {
      entry.execs.delete(execId);
    }

    return status;
  }

  /**
   * Waits until the command finishes or `waitMs` passes. When `forOutput` is
   * set, new output also ends the wait, after a short batch.
   */
  private async waitForChange(
    exec: Exec,
    waitMs: number,
    forOutput: boolean,
  ): Promise<void> {
    const deadline = this.now() + waitMs;
    let timer: NodeJS.Timeout | undefined;
    let waiter: (() => void) | undefined;

    try {
      await new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMs);
        void exec.finished.then(resolve);

        if (forOutput) {
          waiter = () => {
            if (exec.status.done) {
              resolve();
              return;
            }
            // The first chunk starts the batch; the ones after it join it.
            exec.waiters.delete(waiter!);
            clearTimeout(timer);
            timer = setTimeout(
              resolve,
              Math.max(Math.min(BATCH_MS, deadline - this.now()), 0),
            );
          };
          exec.waiters.add(waiter);
        }
      });
    } finally {
      clearTimeout(timer);
      if (waiter) {
        exec.waiters.delete(waiter);
      }
    }
  }

  /**
   * The model calls the sandbox's egress metered after `since`. A runtime that
   * meters nothing answers with none, so the server falls back to what the
   * harness reported.
   */
  async modelCalls(id: string, since: number): Promise<SandboxHostModelCalls> {
    const handle = this.entry(id).handle;
    return handle.modelCalls
      ? handle.modelCalls(since)
      : { calls: [], next: since };
  }

  readFile(id: string, path: string): Promise<string> {
    return this.entry(id).handle.readFile(path);
  }

  writeFile(id: string, path: string, contents: string): Promise<void> {
    return this.entry(id).handle.writeFile(path, contents);
  }

  /** Safe to call for a sandbox that is already gone. */
  async dispose(id: string, reason = "the server asked"): Promise<void> {
    const entry = this.entries.get(id);

    if (!entry) {
      return;
    }

    this.entries.delete(id);
    await entry.handle.dispose();

    log.info("Disposed of a sandbox", {
      sandboxId: id,
      runId: entry.runId,
      reason,
    });
  }

  /** Disposes of every sandbox past its deadline or idle for too long. */
  async sweep(): Promise<void> {
    const now = this.now();

    for (const entry of [...this.entries.values()]) {
      if (now >= entry.deadlineAt) {
        await this.dispose(entry.id, "it passed its deadline");
      } else if (now - entry.lastTouchedAt >= this.options.idleMs) {
        await this.dispose(entry.id, "no request came for it");
      }
    }
  }

  async disposeAll(reason: string): Promise<void> {
    await Promise.all(
      [...this.entries.keys()].map((id) => this.dispose(id, reason)),
    );
  }

  private entry(id: string): Entry {
    const entry = this.entries.get(id);

    if (!entry) {
      throw new NotFoundError(`No sandbox ${id}`);
    }

    entry.lastTouchedAt = this.now();

    return entry;
  }
}

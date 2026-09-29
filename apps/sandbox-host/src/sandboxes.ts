import type {
  SandboxHandle,
  SandboxHostExecStatus,
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
}

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

    const exec: Exec = { status: { done: false }, finished: Promise.resolve() };
    exec.finished = entry.handle
      .exec(command, { timeoutMs: Math.min(timeoutMs ?? remaining, remaining) })
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
      );

    entry.execs.set(execId, exec);

    return execId;
  }

  /**
   * Where a command is, waiting up to `waitMs` for it to finish. A finished
   * command is given out once and then forgotten.
   */
  async waitExec(
    id: string,
    execId: string,
    waitMs: number,
  ): Promise<SandboxHostExecStatus> {
    const entry = this.entry(id);
    const exec = entry.execs.get(execId);

    if (!exec) {
      throw new NotFoundError(`No command ${execId} in sandbox ${id}`);
    }

    if (!exec.status.done && waitMs > 0) {
      let timer: NodeJS.Timeout | undefined;

      await Promise.race([
        exec.finished,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
        }),
      ]);
      clearTimeout(timer);
    }

    if (exec.status.done) {
      entry.execs.delete(execId);
    }

    return exec.status;
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

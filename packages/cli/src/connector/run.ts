/**
 * One local run, from `run.dispatch` to `run.finished`.
 *
 * It makes the worktree, seeds the run directory, starts omp in RPC mode and
 * streams what omp does to the server through the run's acknowledged queue.
 * The worktree stays after the run, so the person can resume in it.
 */
import type {
  ConnectorRunDispatch,
  ConnectorRunOutcome,
} from '@vantikhq/types';

import { FileTail, ompArgs, ompEnv, spawnOmp } from './omp';
import { AckedQueue, type QueueTransport } from './queue';
import { OmpDriver, type OmpChildLike, type OmpEvent } from './rpc';
import { installMcpOverride, seedRunDir } from './seed';
import {
  commitWorktree,
  excludeRunFiles,
  createWorktree,
  runDirFor,
  runGit,
  vantikHome,
  worktreePathFor,
  type GitRunner,
} from './worktree';

type Env = Record<string, string | undefined>;

export interface RunDeps {
  transport: QueueTransport;
  /** Absolute path of the Vantik extension file for `-e`. */
  extensionPath: string;
  log(message: string): void;
  home?: string;
  env?: Env;
  git?: GitRunner;
  spawnOmp?: (
    args: string[],
    options: { cwd: string; env: Env },
  ) => OmpChildLike;
  /** The batch interval for omp events. */
  eventBatchMs?: number;
}

const OUTBOX_POLL_MS = 500;
const FLUSH_TIMEOUT_MS = 60_000;
const CANCEL_GRACE_MS = 5_000;

export class LocalRun {
  readonly runId: string;
  readonly queue: AckedQueue;
  /** Where this run works, for the connector to refuse a second run there. */
  readonly worktreePath: string;
  readonly branch: string;

  private cancelled = false;
  /** The server no longer tracks this run; nothing more is sent for it. */
  private untracked = false;
  private deadlineHit = false;
  private abortNow: (() => void) | undefined;
  private finished: Promise<void> | undefined;

  constructor(
    private readonly dispatch: ConnectorRunDispatch,
    private readonly deps: RunDeps,
  ) {
    this.runId = dispatch.runId;
    this.branch = dispatch.branch;
    this.worktreePath = worktreePathFor(
      deps.home ?? vantikHome(),
      dispatch.repo.fullName,
      dispatch.issue.key,
    );
    this.queue = new AckedQueue(dispatch.runId, deps.transport, {
      onRefusal: (_message, reason) => {
        if (reason.startsWith('untracked:') && !this.untracked) {
          deps.log(
            `The server no longer tracks ${dispatch.issue.key} (${reason}). Stopping it; the worktree stays.`,
          );
          this.untracked = true;
          this.queue.close();
          this.cancel();
        }
      },
      onDrop: (message, reason) =>
        deps.log(
          `The server refused ${message.event} #${message.seq}: ${reason}`,
        ),
    });
  }

  /** Runs to the end. Never rejects: a failure becomes `run.finished`. */
  start(): Promise<void> {
    this.finished ??= this.execute().catch((error: unknown) => {
      this.deps.log(`Run ${this.runId} broke: ${String(error)}`);
    });
    return this.finished;
  }

  cancel() {
    if (!this.cancelled) {
      this.cancelled = true;
      this.abortNow?.();
    }
  }

  private async execute(): Promise<void> {
    const { dispatch, deps } = this;
    const home = deps.home ?? vantikHome();
    const git = deps.git ?? runGit;

    let driver: OmpDriver | undefined;
    let outcome: ConnectorRunOutcome = 'succeeded';
    let error: string | null = null;
    let summary: string | null = null;
    let worktree: Awaited<ReturnType<typeof createWorktree>> | undefined;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let restoreMcp: (() => void) | undefined;

    try {
      worktree = await createWorktree(
        {
          repoPath: dispatch.repo.path,
          worktreePath: this.worktreePath,
          branch: dispatch.branch,
          baseRef: dispatch.repo.baseRef,
        },
        git,
      );
      deps.log(
        `${dispatch.issue.key}: worktree ${worktree.path} on ${worktree.branch}`,
      );

      // The run's token replaces the person's own `vantik` MCP server.
      await excludeRunFiles(worktree.path, git);
      restoreMcp = installMcpOverride(
        worktree.path,
        dispatch.token,
        this.runId,
      );

      const seeded = seedRunDir(
        runDirFor(home, this.runId),
        worktree.path,
        dispatch,
      );
      const env = ompEnv(deps.env ?? process.env, {
        token: dispatch.token,
        policyPath: seeded.policyPath,
        emptyConfigDir: seeded.emptyConfigDir,
      });

      const child = (deps.spawnOmp ?? spawnOmp)(
        ompArgs(dispatch, deps.extensionPath),
        { cwd: worktree.path, env },
      );
      driver = new OmpDriver(child);
      const omp = driver;

      // Batched events.
      let events: unknown[] = [];
      const flushEvents = () => {
        if (events.length > 0) {
          this.queue.send('run.events', { events });
          events = [];
        }
      };
      timers.push(setInterval(flushEvents, deps.eventBatchMs ?? 250));

      // Custom entries: poll after the events that can add one.
      let entryPoll: Promise<void> = Promise.resolve();
      const pollEntries = () => {
        entryPoll = entryPoll.then(async () => {
          try {
            const entries = await omp.pollEntries();
            if (entries.length > 0) {
              this.queue.send('run.entries', { entries });
            }
          } catch (e) {
            deps.log(`Could not read session entries: ${String(e)}`);
          }
        });
        return entryPoll;
      };
      omp.onEvent((event: OmpEvent) => {
        events.push(event);
        if (
          event.type === 'message_end' ||
          event.type === 'tool_execution_end'
        ) {
          void pollEntries();
        }
      });

      // The outbox.
      const tail = new FileTail(seeded.outboxPath);
      const flushOutbox = () => {
        const lines = tail.read();
        if (lines.length > 0) {
          this.queue.send('run.outbox', { lines });
        }
      };
      timers.push(setInterval(flushOutbox, OUTBOX_POLL_MS));

      // Cancel and deadline.
      const stopped = new Promise<'cancel' | 'deadline'>((resolve) => {
        this.abortNow = () => resolve('cancel');
        if (this.cancelled) {
          resolve('cancel');
        }
        const left = Date.parse(dispatch.deadlineAt) - Date.now();
        if (Number.isFinite(left)) {
          timers.push(
            setTimeout(
              () => {
                this.deadlineHit = true;
                resolve('deadline');
              },
              Math.max(0, left),
            ),
          );
        }
      });

      await omp.negotiate();
      const state = await omp.getState();
      this.queue.send('run.started', {
        ompSessionId: state.sessionId,
        sessionFile: state.sessionFile,
        worktreePath: worktree.path,
        branch: worktree.branch,
        baseCommit: worktree.baseCommit,
      });

      const agentEnd = omp.waitForIdle();
      agentEnd.catch(() => undefined);
      const promptSent = omp.prompt(dispatch.prompt);

      const winner = await Promise.race([
        agentEnd.then(() => 'end' as const),
        promptSent.then(() => new Promise<never>(() => undefined)),
        stopped,
        omp.exited.then(() => 'exit' as const),
      ]).catch((e: unknown) => {
        // The prompt was refused, or omp died while a request was open.
        throw e instanceof Error ? e : new Error(String(e));
      });

      if (winner === 'cancel' || winner === 'deadline') {
        await Promise.race([
          omp.abort().catch(() => undefined),
          new Promise((resolve) => setTimeout(resolve, CANCEL_GRACE_MS)),
        ]);
        outcome = winner === 'cancel' ? 'cancelled' : 'failed';
        error = winner === 'cancel' ? null : 'The run passed its deadline.';
      } else if (winner === 'exit') {
        const exit = await omp.exited;
        outcome = 'failed';
        error =
          exit.error?.message ??
          `omp exited (${exit.signal ?? `code ${String(exit.code)}`}) before the agent finished.${
            exit.stderrTail ? ` ${exit.stderrTail.slice(-1000)}` : ''
          }`;
      } else {
        const last = omp.lastAssistantMessage;
        if (last?.stopReason === 'error') {
          outcome = 'failed';
          error = last.errorMessage ?? 'The model call failed.';
        }
      }

      summary = omp.lastAssistantMessage?.text.trim() || null;

      flushEvents();
      await pollEntries();
      flushOutbox();
    } catch (e) {
      outcome = this.cancelled ? 'cancelled' : 'failed';
      error = e instanceof Error ? e.message : String(e);
      if (driver?.stderrTail) {
        error += ` — ${driver.stderrTail.slice(-1000)}`;
      }
    } finally {
      for (const timer of timers) {
        clearInterval(timer);
        clearTimeout(timer);
      }
    }

    let branch: string | null = null;
    let headCommit: string | null = null;
    if (worktree && !this.untracked) {
      try {
        const result = await commitWorktree(
          {
            worktreePath: worktree.path,
            branch: worktree.branch,
            baseCommit: worktree.baseCommit,
            message: `${dispatch.issue.key}: ${dispatch.issue.title}`,
          },
          deps.git ?? runGit,
        );
        branch = result.branch;
        headCommit = result.headCommit;
      } catch (e) {
        if (outcome === 'succeeded') {
          outcome = 'failed';
        }
        error = [error, `Could not commit the work: ${String(e)}`]
          .filter(Boolean)
          .join(' ');
      }
    }

    if (!this.untracked) {
      this.queue.send('run.finished', {
        outcome,
        summary,
        branch,
        headCommit,
        error,
      });
      const delivered = await this.queue.drain(FLUSH_TIMEOUT_MS);
      if (!delivered) {
        this.deps.log(
          `The server did not confirm the end of ${dispatch.issue.key}; it will fail the run at its deadline.`,
        );
      }
      this.queue.close();
    }

    if (driver) {
      driver.kill();
      await Promise.race([
        driver.exited,
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
      driver.kill('SIGKILL');
    }
    restoreMcp?.();
    deps.log(
      `${dispatch.issue.key}: ${outcome}${this.deadlineHit ? ' (deadline)' : ''}${
        headCommit ? `, ${headCommit.slice(0, 8)} on ${branch}` : ''
      }`,
    );
  }
}

/**
 * Who holds an omp session: a terminal, this connector, or nobody.
 *
 * omp keeps an advisory lock on `~/.omp/run/session-owners/<id>.lock` while a
 * process has the session open. The file has no pid in it, so this module asks
 * `lsof` which processes hold the file. The connector never writes to a session
 * that another process holds: omp forks to a new file in that case, and the
 * person's terminal would not see the change.
 */
import type { ConnectorSessionDriver } from '@vantikhq/types';

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/** How often the connector checks the locks. */
export const DRIVER_POLL_MS = 15_000;
/** How often the connector asks the server for the sessions to watch. */
export const WATCH_REFRESH_MS = 60 * 60 * 1000;
/**
 * A driver that is not null goes to the server again after this long, because
 * the server's lease on it ends after a minute. The interval is shorter than
 * the lease, so a renewal arrives in time even when one check is slow.
 */
export const DRIVER_HEARTBEAT_MS = 40_000;
/** A finished run keeps its session on the watch list for this long. */
const OWN_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** The most parent processes to walk when a holder is not a direct child. */
const MAX_ANCESTORS = 8;

export type SessionDriverName = ConnectorSessionDriver['driver'];

/** Process ids that hold each file. A file that nobody holds is absent. */
export type HolderMap = Map<string, number[]>;

export function ompRunDirPath(): string {
  return path.join(homedir(), '.omp', 'run');
}

export function ownerLockPath(
  sessionId: string,
  runDir: string = ompRunDirPath(),
): string {
  return path.join(runDir, 'session-owners', `${sessionId}.lock`);
}

/**
 * Asks `lsof` who holds the files, in one call. Returns null when `lsof` is
 * not installed, so the caller can skip the check. A file that does not exist
 * would make `lsof` fail for all the others, so only existing files go in.
 */
export function lsofHolders(files: string[]): Promise<HolderMap | null> {
  const existing = files.filter((file) => existsSync(file));
  if (existing.length === 0) {
    return Promise.resolve(new Map());
  }

  return new Promise((resolve) => {
    execFile(
      'lsof',
      ['-F', 'pn', '--', ...existing],
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error && (error as { code?: string }).code === 'ENOENT') {
          resolve(null);
          return;
        }
        // `lsof` exits with 1 when some file has no holder. That is normal.
        resolve(parseLsof(String(stdout ?? '')));
      },
    );
  });
}

/** Reads `lsof -F pn` output: `p<pid>` lines, each followed by `n<file>`. */
export function parseLsof(output: string): HolderMap {
  const holders: HolderMap = new Map();
  let pid: number | null = null;

  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      const value = Number(line.slice(1));
      pid = Number.isInteger(value) ? value : null;
    } else if (line.startsWith('n') && pid !== null) {
      const file = line.slice(1);
      const list = holders.get(file) ?? [];
      if (!list.includes(pid)) {
        list.push(pid);
      }
      holders.set(file, list);
    }
  }

  return holders;
}

/** The parent of a process, or null when it is gone. */
export function parentPid(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-o', 'ppid=', '-p', String(pid)],
      { timeout: 5_000 },
      (error, stdout) => {
        const value = Number(String(stdout ?? '').trim());
        resolve(error || !Number.isInteger(value) || value <= 0 ? null : value);
      },
    );
  });
}

/** The holders of a file. `lsof` may print the path in another spelling. */
function holdersOf(holders: HolderMap, file: string): number[] | undefined {
  const exact = holders.get(file);
  if (exact) {
    return exact;
  }
  const name = path.basename(file);
  for (const [key, pids] of holders) {
    if (path.basename(key) === name) {
      return pids;
    }
  }
  return undefined;
}

export interface SessionDriversOptions {
  /** Replaces `lsofHolders`, for tests. */
  holders?(files: string[]): Promise<HolderMap | null>;
  /** Replaces `parentPid`, for tests. */
  parentOf?(pid: number): Promise<number | null>;
  /** Replaces the lock file path, for tests. */
  lockPath?(sessionId: string): string;
  now?(): number;
  log(message: string): void;
}

/** What the connector tells this class about its own runs. */
export interface OwnRun {
  sessionId?: string;
  pid?: number;
}

export class SessionDrivers {
  /** The sessions of this connector's runs, and when each was last live. */
  private readonly own = new Map<string, number>();
  private ownPids = new Set<number>();
  private watched = new Set<string>();
  /** The last driver found for each session, by session id. */
  private readonly found = new Map<string, SessionDriverName>();
  /** The last driver the server acknowledged, by session id. */
  private readonly reported = new Map<
    string,
    { driver: SessionDriverName; at: number }
  >();
  private warned = false;
  private ancestors = new Map<number, boolean>();

  constructor(private readonly options: SessionDriversOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private lockPath(sessionId: string): string {
    return (this.options.lockPath ?? ownerLockPath)(sessionId);
  }

  private probe(files: string[]): Promise<HolderMap | null> {
    return (this.options.holders ?? lsofHolders)(files);
  }

  /** The sessions the server lists: the person's terminal sessions. */
  setWatched(sessionIds: string[]): void {
    this.watched = new Set(sessionIds);
  }

  /** Every session to look at: the watch list and this connector's own runs. */
  sessionIds(): string[] {
    return [...new Set([...this.own.keys(), ...this.watched])];
  }

  /** The driver the last check found, or undefined before any check ran. */
  driverOf(sessionId: string): SessionDriverName | undefined {
    return this.found.get(sessionId);
  }

  /** Forgets what the server was told, so the next check reports everything. */
  resetReported(): void {
    this.reported.clear();
  }

  /**
   * Notes the runs in this process. A run that is live holds its omp's pid; a
   * run that ended keeps its session on the list for a day.
   */
  syncRuns(runs: OwnRun[]): void {
    const now = this.now();
    this.ownPids = new Set();
    this.ancestors.clear();

    for (const run of runs) {
      if (run.pid) {
        this.ownPids.add(run.pid);
      }
      if (run.sessionId) {
        this.own.set(run.sessionId, now);
      }
    }

    for (const [id, seen] of this.own) {
      if (now - seen > OWN_SESSION_TTL_MS) {
        this.own.delete(id);
      }
    }
  }

  /** Whether a holder is the connector's own omp, or one of its children. */
  private async isOwn(pid: number): Promise<boolean> {
    if (this.ownPids.has(pid)) {
      return true;
    }
    if (this.ownPids.size === 0) {
      return false;
    }
    const cached = this.ancestors.get(pid);
    if (cached !== undefined) {
      return cached;
    }

    const parentOf = this.options.parentOf ?? parentPid;
    let current: number | null = pid;
    let own = false;
    for (let depth = 0; depth < MAX_ANCESTORS && current; depth += 1) {
      current = await parentOf(current);
      if (current && this.ownPids.has(current)) {
        own = true;
        break;
      }
    }
    this.ancestors.set(pid, own);
    return own;
  }

  private async classify(
    pids: number[] | undefined,
  ): Promise<SessionDriverName> {
    if (!pids || pids.length === 0) {
      return null;
    }
    for (const pid of pids) {
      if (!(await this.isOwn(pid))) {
        return 'TERMINAL';
      }
    }
    return 'VANTIK';
  }

  /**
   * One check of every session to watch, with one `lsof` call. Returns the
   * sessions whose driver differs from the last acknowledged report, and the
   * ones with a driver that the server has not heard about lately. Call
   * {@link commit} with the result once the server has acknowledged it.
   */
  async poll(): Promise<ConnectorSessionDriver[]> {
    const ids = [...new Set([...this.own.keys(), ...this.watched])];
    if (ids.length === 0) {
      return [];
    }

    const files = new Map(ids.map((id) => [this.lockPath(id), id]));
    const holders = await this.probe([...files.keys()]);

    if (!holders) {
      if (!this.warned) {
        this.warned = true;
        this.options.log(
          'lsof was not found, so the connector cannot tell which sessions your terminal holds.',
        );
      }
      return [];
    }

    const changes: ConnectorSessionDriver[] = [];
    for (const [file, id] of files) {
      const driver = await this.classify(holdersOf(holders, file));
      this.found.set(id, driver);
      const last = this.reported.get(id);
      if (
        !last ||
        last.driver !== driver ||
        (driver !== null && this.now() - last.at >= DRIVER_HEARTBEAT_MS)
      ) {
        changes.push({ externalId: id, driver });
      }
    }
    return changes;
  }

  /** Records that the server took these changes. */
  commit(changes: ConnectorSessionDriver[]): void {
    for (const change of changes) {
      this.reported.set(change.externalId, {
        driver: change.driver,
        at: this.now(),
      });
    }
  }

  /**
   * Whether a process other than this connector's own omp holds the session.
   * When the check cannot run (no `lsof`), the answer is yes: the connector
   * does not write to a session that it cannot show to be free.
   */
  async isHeldByOther(sessionId: string): Promise<boolean> {
    const file = this.lockPath(sessionId);
    const holders = await this.probe([file]);
    if (!holders) {
      return true;
    }
    return (await this.classify(holdersOf(holders, file))) === 'TERMINAL';
  }
}

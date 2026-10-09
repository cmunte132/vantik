/**
 * The socket side of `vantik connect`: connects to the server's `/connector`
 * namespace, says hello, and runs what the server dispatches.
 */

import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

import {
  CONNECTOR_NAMESPACE,
  CONNECTOR_OMP_VERSION,
  CONNECTOR_PROTOCOL_VERSION,
  type ConnectorHello,
  type ConnectorHelloAck,
  type ConnectorModels,
  type ConnectorRunAnswer,
  type ConnectorRunCancel,
  type ConnectorRunDispatch,
  type ConnectorSessionsWatchAck,
} from '@vantikhq/types';
import { io } from 'socket.io-client';

import { discoverModels, MODEL_REFRESH_MS, modelsChanged } from './models';
import { discoverOmp, ompAgentDirPath, type OmpInstall } from './omp';
import { AckedQueue, type QueueTransport } from './queue';
import { LocalRun, type RunDeps } from './run';
import {
  DRIVER_POLL_MS,
  SessionDrivers,
  WATCH_REFRESH_MS,
} from './session-drivers';
import { vantikHome, worktreePathFor } from './worktree';

export interface ConnectorOptions {
  /** The server origin that serves the `/connector` namespace. */
  socketUrl: string;
  /** The app or API URL the token belongs to, for the status line. */
  apiUrl: string;
  token: string;
  connectorVersion: string;
  extensionPath: string;
  log(message: string): void;
  /** Replaces `omp models`, for tests. */
  discoverModels?(): Promise<ConnectorModels>;
  /** Replaces `LocalRun`, for tests. */
  createRun?(dispatch: ConnectorRunDispatch, deps: RunDeps): ActiveRun;
  /** Replaces the lock check, for tests. */
  drivers?: SessionDrivers;
}

/** What the connector needs from a run. */
export type ActiveRun = Pick<
  LocalRun,
  'runId' | 'branch' | 'worktreePath' | 'queue' | 'start' | 'cancel' | 'answer'
> &
  Partial<Pick<LocalRun, 'ompSessionId' | 'ompPid'>>;

const defaultCreateRun = (dispatch: ConnectorRunDispatch, deps: RunDeps) =>
  new LocalRun(dispatch, deps);

/**
 * The origin of the realtime gateway. The webapp proxies `/api` but not the
 * socket, so the server publishes its public origin in the client config;
 * a server that does not publish one is its own gateway.
 */
export async function resolveSocketUrl(
  apiUrl: string,
  fetchJson: (url: string) => Promise<unknown> = defaultFetchJson,
): Promise<string | null> {
  const root = apiUrl.replace(/\/+$/, '');
  let answered = false;
  for (const url of [`${root}/api/v1/config`, `${root}/v1/config`]) {
    try {
      const config = (await fetchJson(url)) as { socketHost?: unknown };
      answered = true;
      if (typeof config.socketHost === 'string' && config.socketHost) {
        return config.socketHost.replace(/\/+$/, '');
      }
    } catch {
      // Try the next place.
    }
  }
  // A server that answered without announcing a gateway serves it itself. One
  // that did not answer at all may still be starting, and guessing now would
  // pin the connector to the wrong origin for as long as it runs.
  return answered ? root : null;
}

/** The gateway's origin, asking again until the server answers. */
export async function waitForSocketUrl(
  apiUrl: string,
  log: (message: string) => void,
  resolve: (apiUrl: string) => Promise<string | null> = resolveSocketUrl,
): Promise<string> {
  let delayMs = 1_000;
  let warned = false;
  for (;;) {
    const url = await resolve(apiUrl);
    if (url) {
      return url;
    }
    if (!warned) {
      log(`Cannot reach ${apiUrl} yet. Waiting for it.`);
      warned = true;
    }
    await new Promise((done) => setTimeout(done, delayMs));
    delayMs = Math.min(delayMs * 2, 30_000);
  }
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}`);
  }
  return response.json();
}

/**
 * Whether the person's omp has an MCP server, not named `vantik`, on this
 * Vantik server. omp loads it with the person's own token, which the run's
 * `vantik` override cannot replace.
 */
export function findPersonalVantikMcp(
  agentDir: string,
  apiUrl: string,
): string | null {
  try {
    const config = JSON.parse(
      readFileSync(path.join(agentDir, 'mcp.json'), 'utf8'),
    ) as { mcpServers?: Record<string, { url?: unknown }> };
    const host = new URL(apiUrl).host;
    for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
      // A server named `vantik` is replaced in every run by one on the run's token.
      if (name === 'vantik') {
        continue;
      }
      if (typeof server.url === 'string' && new URL(server.url).host === host) {
        return name;
      }
    }
  } catch {
    // No file, or not readable: nothing to warn about.
  }
  return null;
}

/** A connect error that a new attempt with the same token cannot fix. */
const AUTH_ERROR =
  /unauthori[sz]ed|invalid|expired|revoked|forbidden|\b40[13]\b/i;

export class Connector {
  private readonly runs = new Map<string, ActiveRun>();
  private socket: ReturnType<typeof io> | undefined;
  private lastConnectError = '';
  private retryDelayMs = 500;
  /** The last models found, or undefined when omp could not list any. */
  private models: ConnectorModels | undefined;
  private modelTimer: ReturnType<typeof setInterval> | undefined;
  private driverTimer: ReturnType<typeof setInterval> | undefined;
  private watchTimer: ReturnType<typeof setInterval> | undefined;
  private checkingDrivers = false;
  private readonly drivers: SessionDrivers;

  constructor(private readonly options: ConnectorOptions) {
    this.drivers = options.drivers ?? new SessionDrivers({ log: options.log });
  }

  /** Connects and stays connected. Resolves when `stop` finishes. */
  async run(): Promise<void> {
    const { log } = this.options;
    const install = await discoverOmp();
    this.warnAboutOmp(install);
    if (install.version) {
      await this.refreshModels(true);
    }

    const socket = io(`${this.options.socketUrl}${CONNECTOR_NAMESPACE}`, {
      auth: { token: this.options.token },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
    });
    this.socket = socket;

    if (install.version) {
      this.modelTimer = setInterval(
        () => void this.refreshModels(false),
        MODEL_REFRESH_MS,
      );
      this.modelTimer.unref();
    }

    const transport: QueueTransport = {
      get connected() {
        return socket.connected;
      },
      emit: (event, payload, ack) => {
        socket.emit(event, payload, ack);
      },
    };

    const finished = new Promise<void>((resolve) => {
      socket.on('connect', () => {
        this.lastConnectError = '';
        this.retryDelayMs = 500;
        const hello = this.hello(install);
        socket.emit('hello', hello, (ack: ConnectorHelloAck | undefined) => {
          if (!ack || !ack.ok) {
            log(
              `The server refused this connector: ${ack?.reason ?? 'no answer'}`,
            );
            void this.stop().then(resolve);
            process.exitCode = 1;
            return;
          }
          log(
            `Connected to ${this.options.apiUrl} as ${ack.userId}, workspace ${ack.workspaceId}, ${
              install.version ? `omp ${install.version}` : 'omp not found'
            }. Waiting for work; delegate an issue from Vantik.`,
          );
          for (const run of this.runs.values()) {
            run.queue.resume();
          }
          this.watchSessions(ack.watchSessions ?? []);
        });
      });

      socket.on('connect_error', (error: Error) => {
        const rejected = AUTH_ERROR.test(error.message);
        if (error.message !== this.lastConnectError) {
          this.lastConnectError = error.message;
          log(
            rejected
              ? `The server did not accept your login (${error.message}). Run \`vantik login\` and try again.`
              : `Cannot reach ${this.options.socketUrl} (${error.message}). Retrying.`,
          );
        }
        if (rejected) {
          // Retrying with the same token cannot work.
          process.exitCode = 1;
          void this.stop().then(resolve);
          return;
        }
        // A rejection by the server's middleware stops socket.io's own
        // reconnecting; start it again after a pause.
        if (!socket.active) {
          this.retryDelayMs = Math.min(this.retryDelayMs * 2, 30_000);
          setTimeout(() => {
            if (!socket.connected && !socket.active) {
              socket.connect();
            }
          }, this.retryDelayMs);
        }
      });

      socket.on('disconnect', (reason: string) => {
        log(`Disconnected (${reason}). Reconnecting.`);
      });

      socket.on(
        'run.dispatch',
        (dispatch: ConnectorRunDispatch, ack?: (response: unknown) => void) => {
          if (typeof ack === 'function') {
            ack({ ok: true });
          }
          this.dispatch(dispatch, transport, install);
        },
      );
      socket.on(
        'run.cancel',
        (cancel: ConnectorRunCancel, ack?: (response: unknown) => void) => {
          this.runs.get(cancel.runId)?.cancel();
          ack?.({ ok: true });
        },
      );

      socket.on(
        'run.answer',
        (answer: ConnectorRunAnswer, ack?: (response: unknown) => void) => {
          const run = this.runs.get(answer?.runId);
          ack?.(
            run
              ? run.answer(answer)
              : { ok: false, reason: 'This connector has no such run.' },
          );
        },
      );

      // The first signal stops cleanly, cancelling active runs; a second one
      // does not wait for them.
      const onSignal = () => {
        process.once('SIGINT', () => process.exit(130));
        void this.stop().then(resolve);
      };
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
    });

    await finished;
  }

  /**
   * Asks omp for its models. A failure is never fatal: the first one leaves
   * the list empty, a later one keeps the list already known. `models` goes to
   * the server only when the list or the default changed.
   */
  async refreshModels(first: boolean): Promise<void> {
    const { log } = this.options;
    let found: ConnectorModels;
    try {
      found = await (this.options.discoverModels ?? discoverModels)();
    } catch (error) {
      log(
        `Could not list the models in your omp (${error instanceof Error ? error.message : String(error)}). Runs use omp's default model.`,
      );
      return;
    }

    if (!modelsChanged(this.models, found)) {
      return;
    }
    this.models = found;
    if (first) {
      log(`Found ${found.models.length} models in your omp.`);
      return;
    }
    log(`Your omp models changed (${found.models.length} now).`);
    if (this.socket?.connected) {
      this.socket.emit('models', found, () => undefined);
    }
  }

  /**
   * Starts the lock checks. The server's list of the person's terminal
   * sessions replaces the old one, and the first check after a connect reports
   * every session again, because the server may have missed a report.
   */
  private watchSessions(sessions: string[]) {
    this.drivers.setWatched(sessions);
    this.drivers.resetReported();
    void this.checkDrivers();

    if (!this.driverTimer) {
      this.driverTimer = setInterval(
        () => void this.checkDrivers(),
        DRIVER_POLL_MS,
      );
      this.driverTimer.unref();
    }
    if (!this.watchTimer) {
      this.watchTimer = setInterval(
        () => this.refreshWatch(),
        WATCH_REFRESH_MS,
      );
      this.watchTimer.unref();
    }
  }

  /** Asks the server again for the sessions to watch. */
  refreshWatch() {
    if (!this.socket?.connected) {
      return;
    }
    this.socket.emit(
      'sessions.watch',
      {},
      (ack: ConnectorSessionsWatchAck | undefined) => {
        if (ack?.ok && Array.isArray(ack.sessions)) {
          this.drivers.setWatched(ack.sessions);
        }
      },
    );
  }

  /**
   * One lock check. Sends the changes only, and counts them as sent when the
   * server acknowledges them; a report that is lost goes again on the next
   * check.
   */
  async checkDrivers(): Promise<void> {
    if (this.checkingDrivers || !this.socket?.connected) {
      return;
    }
    this.checkingDrivers = true;
    try {
      this.drivers.syncRuns(
        [...this.runs.values()].map((run) => ({
          sessionId: run.ompSessionId,
          pid: run.ompPid,
        })),
      );
      const changes = await this.drivers.poll();
      if (changes.length === 0) {
        return;
      }
      this.socket.emit(
        'sessions.drivers',
        { sessions: changes },
        (ack: { ok?: boolean } | undefined) => {
          if (ack?.ok) {
            this.drivers.commit(changes);
          }
        },
      );
    } catch (error) {
      this.options.log(`Could not check your omp sessions: ${String(error)}`);
    } finally {
      this.checkingDrivers = false;
    }
  }

  private dispatch(
    dispatch: ConnectorRunDispatch,
    transport: QueueTransport,
    install: OmpInstall,
  ) {
    const { log } = this.options;
    if (this.runs.has(dispatch.runId)) {
      return;
    }

    const busy = [...this.runs.values()].find(
      (other) =>
        other.worktreePath === this.pathFor(dispatch) ||
        other.branch === dispatch.branch,
    );
    if (busy) {
      log(
        `${dispatch.issue.key}: refused, run ${busy.runId} is already active in that worktree.`,
      );
      const queue = new AckedQueue(dispatch.runId, transport);
      queue.send('run.finished', {
        outcome: 'failed',
        summary: null,
        branch: null,
        headCommit: null,
        error: `A run is already active in that worktree (${busy.runId}, branch ${busy.branch}). It must finish before this one can start.`,
      });
      void queue.drain(60_000).finally(() => queue.close());
      return;
    }

    const run = (this.options.createRun ?? defaultCreateRun)(dispatch, {
      transport,
      extensionPath: this.options.extensionPath,
      log,
      isHeldByOther: (sessionId) => this.drivers.isHeldByOther(sessionId),
    });
    this.runs.set(dispatch.runId, run);
    log(`${dispatch.issue.key}: starting "${dispatch.issue.title}"`);

    if (!install.version) {
      log(
        'omp is not installed, so the run will fail. Install it from https://github.com/can1357/oh-my-pi.',
      );
    }
    void run.start().finally(() => this.runs.delete(dispatch.runId));
  }

  /**
   * The runs active in this process. A run is in the set from the moment its
   * dispatch is accepted, before the worktree exists, and leaves it when its
   * `run.finished` is settled or the server stops tracking it.
   */
  activeRunIds(): string[] {
    return [...this.runs.keys()];
  }

  hello(install: OmpInstall): ConnectorHello {
    return {
      protocolVersion: CONNECTOR_PROTOCOL_VERSION,
      connectorVersion: this.options.connectorVersion,
      hostname: hostname(),
      ompVersion: install.version,
      ompAgentDir: install.agentDir,
      activeRunIds: this.activeRunIds(),
      ...(this.models
        ? {
            models: this.models.models,
            defaultModel: this.models.defaultModel,
          }
        : {}),
    };
  }

  private pathFor(dispatch: ConnectorRunDispatch): string {
    return worktreePathFor(
      vantikHome(),
      dispatch.repo.fullName,
      dispatch.issue.key,
    );
  }

  private warnAboutOmp(install: OmpInstall) {
    const { log } = this.options;
    if (!install.version) {
      log(
        'omp was not found on your PATH. Install oh-my-pi (https://github.com/can1357/oh-my-pi), then run `vantik connect` again.',
      );
      return;
    }
    if (install.version !== CONNECTOR_OMP_VERSION) {
      log(
        `You have omp ${install.version}; this connector is tested with ${CONNECTOR_OMP_VERSION}. It should work, but report anything odd.`,
      );
    }
    if (!install.agentDir) {
      log(
        `${ompAgentDirPath()} does not exist. Run omp once and log in to a model provider first.`,
      );
    }
    const mcp = findPersonalVantikMcp(ompAgentDirPath(), this.options.apiUrl);
    if (mcp) {
      log(
        `Your omp config has an MCP server "${mcp}" on this Vantik server. omp loads it with your own token, so a run can use it. Remove it from ${path.join(ompAgentDirPath(), 'mcp.json')} if runs must hold only their own token.`,
      );
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.modelTimer);
    clearInterval(this.driverTimer);
    clearInterval(this.watchTimer);
    for (const run of this.runs.values()) {
      run.cancel();
    }
    // Runs get a moment to report that they were cancelled. The timer is
    // cleared either way, or it alone keeps the process alive after Ctrl-C.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([...this.runs.values()].map((run) => run.start())),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 20_000);
      }),
    ]);
    clearTimeout(timer);
    this.socket?.disconnect();
  }
}

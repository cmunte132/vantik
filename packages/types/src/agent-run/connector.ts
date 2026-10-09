/**
 * The wire protocol between the Vantik server and `vantik connect`.
 *
 * `vantik connect` is a process on the person's own machine. It opens an
 * outbound socket.io connection to the namespace below, so the machine needs no
 * open port, and the same process works against a local or a remote server. It
 * runs omp (oh-my-pi) with the person's own `~/.omp/agent`, so their logins,
 * skills and session store are the harness.
 *
 * The server decides what runs. A person delegates from the issue (delegation
 * is UI-only); the server then sends `run.dispatch` to that person's
 * connector. The connector never asks for work.
 *
 * Every connector-to-server message is sent with an acknowledgement, and the
 * connector retries a message that is not acknowledged. The server treats each
 * message as idempotent per (runId, seq).
 */

import type { AgentQuestionAnswer, AgentQuestionItem } from '../agent-question';

/** The socket.io namespace the connector connects to. */
export const CONNECTOR_NAMESPACE = '/connector';

/**
 * The version of this protocol. The server refuses a `hello` with a different
 * major version, so an old connector fails with a clear message.
 */
export const CONNECTOR_PROTOCOL_VERSION = 1;

/**
 * The omp version the connector is tested against. The connector runs a
 * different version, but says so in `hello`, and the server shows it.
 */
export const CONNECTOR_OMP_VERSION = '18.8.6';

/** The executor key a local run carries. */
export const LOCAL_EXECUTOR_KEY = 'local';

// ---------------------------------------------------------------------------
// Connector → server

/**
 * The first message after the connection. The socket authenticates with the
 * person's CLI token in the handshake (`auth: { token }`); `hello` describes
 * the machine.
 */
export interface ConnectorHello {
  protocolVersion: number;
  connectorVersion: string;
  hostname: string;
  /** The omp version found on the PATH, or null when omp is not installed. */
  ompVersion: string | null;
  /** Whether `~/.omp/agent` (or `$PI_CODING_AGENT_DIR`) exists. */
  ompAgentDir: boolean;
  /**
   * The runs this connector is working on now. The server fails any run it
   * tracks for this person that is not listed, so a restarted connector does
   * not leave a run RUNNING until its deadline. Absent from an older
   * connector, in which case the server trusts its own state.
   */
  activeRunIds?: string[];
  /**
   * The chat models the person's omp can use (the providers they are signed in
   * to). Absent from an older connector, or when omp could not list them.
   */
  models?: ConnectorModel[];
  /** The selector (`provider/id`) of omp's own default model, if it has one. */
  defaultModel?: string | null;
}

/** One model of the person's omp, as `omp models --json` lists it. */
export interface ConnectorModel {
  provider: string;
  /** The model id, without the provider. */
  id: string;
  name: string;
  /** Whether the model reasons, so `--thinking` does something. */
  reasoning: boolean;
  /**
   * The `--thinking` levels the model accepts, or null when omp did not say.
   */
  thinkingLevels: string[] | null;
}

/**
 * The person's models changed (a login, a logout, a new default). Sent outside
 * any run, so it carries no seq. Acknowledged like the other messages.
 */
export interface ConnectorModels {
  models: ConnectorModel[];
  defaultModel: string | null;
}

export type ConnectorHelloAck =
  | {
      ok: true;
      userId: string;
      workspaceId: string;
      /**
       * The omp session ids (uuids) of the person's other local sessions, from
       * the hooks and from earlier connector runs, that were active in the
       * last 24 hours. The connector checks which of them a terminal holds.
       * Absent from an older server.
       */
      watchSessions?: string[];
    }
  | { ok: false; reason: string };

/** Who holds an omp session, as the connector finds out from the lock file. */
export type ConnectorSessionDriverName = 'TERMINAL' | 'VANTIK';

/**
 * One omp session whose holder changed. `driver` is TERMINAL when an omp that
 * the connector did not start holds the session, VANTIK when the connector's
 * own omp holds it, and null when nobody does. `externalId` is the omp session
 * uuid.
 */
export interface ConnectorSessionDriver {
  externalId: string;
  driver: ConnectorSessionDriverName | null;
}

/**
 * Sent outside any run, so it carries no seq. The server updates the driver of
 * the person's own sessions only, and acknowledges with {@link ConnectorAck}.
 */
export interface ConnectorSessionDrivers {
  sessions: ConnectorSessionDriver[];
}

/**
 * The connector asks again for the sessions to watch (`sessions.watch`, about
 * once an hour). It carries no body.
 */
export type ConnectorSessionsWatchAck =
  { ok: true; sessions: string[] } | { ok: false; reason: string };

/** The longest a driver lease lives without a new report from the connector. */
export const SESSION_DRIVER_LEASE_MS = 60_000;

/** The connector has a worktree and an omp session for the run. */
export interface ConnectorRunStarted {
  runId: string;
  seq: number;
  /** The omp session id from `get_state`. */
  ompSessionId: string;
  /** The absolute path of the omp session file. */
  sessionFile: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
}

/**
 * Raw omp RPC events, in order. The server parses them with the same reader as
 * a hosted run (`PiEventReader`), so steps, model, cost and failures read the
 * same way.
 */
export interface ConnectorRunEvents {
  runId: string;
  seq: number;
  events: unknown[];
}

/**
 * Custom session entries from `get_entries {since}`. omp does not emit
 * `entry_appended`, so the connector polls for these after each
 * `message_end` and `tool_execution_end` and sends them here. The server
 * handles each one as a hosted run handles `entry_appended`.
 */
export interface ConnectorRunEntries {
  runId: string;
  seq: number;
  entries: unknown[];
}

/** New lines of the run's outbox file, as written by the Vantik extension. */
export interface ConnectorRunOutbox {
  runId: string;
  seq: number;
  lines: string[];
}

/**
 * A question for a person that omp opened itself: a select, a confirmation or
 * an input dialog. The server stores it as an agent question with the source
 * `omp_dialog`, and answers it with `run.answer` when a person has answered.
 * The questions that the extension tool asks come through the outbox instead.
 */
export interface ConnectorRunQuestion {
  runId: string;
  seq: number;
  /** The connector's id for the dialog. Unique per run. */
  id: string;
  questions: AgentQuestionItem[];
}

export type ConnectorRunOutcome = 'succeeded' | 'failed' | 'cancelled';

export interface ConnectorRunFinished {
  runId: string;
  seq: number;
  outcome: ConnectorRunOutcome;
  /** The agent's last message, used as the run summary. */
  summary: string | null;
  /** The local branch with the run's commits, or null when nothing changed. */
  branch: string | null;
  headCommit: string | null;
  error: string | null;
}

export type ConnectorAck = { ok: true } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Server → connector

/** The repository the run works in, on the connector's machine. */
export interface ConnectorRunRepo {
  /** The local-repository integration's id for the repository. */
  id: string;
  fullName: string;
  /** The absolute checkout path the local-repository integration recorded. */
  path: string;
  /** The ref to branch from, for example `origin/main` or `main`. */
  baseRef: string;
}

export interface ConnectorRunDispatch {
  runId: string;
  issue: { id: string; key: string; title: string };
  repo: ConnectorRunRepo;
  /** The branch to create in the worktree, for example `agent/eng-42`. */
  branch: string;
  /** The first prompt, built the same way as for a hosted run. */
  prompt: string;
  /** The context the extension reads (`context.json`), as JSON. */
  context: unknown;
  /**
   * The extension policy without its paths. The connector fills repoRoot,
   * contextPath and outboxPath with paths on its machine.
   */
  policy: {
    pathPrefixes: string[];
    checks: unknown;
    reachableHosts: string[];
    maxOutputTokens: number | null;
    /** How long `ask_person` waits for a person. Null for the default. */
    questionWaitMs: number | null;
  };
  /**
   * The model the person chose at dispatch. Each field is null to leave omp's
   * own default from the person's `~/.omp/agent`.
   */
  model: {
    provider: string | null;
    model: string | null;
    thinking: string | null;
  };
  /**
   * A token for this run only, minted for the person's personal agent. It ends
   * with the run. The connector gives it to omp as the only Vantik credential.
   */
  token: { value: string; apiUrl: string; expiresAt: string };
  /** The time after which the server fails the run and revokes its token. */
  deadlineAt: string;
  /**
   * An omp session to continue (`--resume`), by its uuid. The server does not
   * send this yet. The connector refuses to resume a session that an omp in a
   * terminal holds, and never writes to it.
   */
  resumeSessionId?: string | null;
}

export interface ConnectorRunCancel {
  runId: string;
}

/**
 * What became of a question for a person, for the connector to hand to the
 * agent. It carries a run and no seq: the connector acknowledges it, and the
 * server sends it again after a reconnect until it is acknowledged.
 *
 * For a question from the tool, the connector writes `answers/<questionId>.json`
 * in the run directory, next to the outbox. For an omp dialog, it replies to
 * the dialog. `expired` and `cancelled` mean that nobody answered.
 */
export interface ConnectorRunAnswer {
  runId: string;
  /** The `id` of the question, as the connector or the extension gave it. */
  questionId: string;
  source: 'tool' | 'omp_dialog';
  status: 'answered' | 'expired' | 'cancelled';
  answers: AgentQuestionAnswer[];
  /** The answers as text, as the tool returns them to the agent. */
  text: string;
  /** Why Vantik refused the question, when it did. Set with `cancelled`. */
  reason?: string;
}

/**
 * One agent session on one issue, from any harness and any channel.
 *
 * A session that works two issues is two rows, so the issue page lists its own
 * sessions with a plain filter. A hosted `AgentRun` has a session too, so
 * there is one list and not two.
 */

export const AGENT_SESSION_LOCATIONS = ['LOCAL', 'HOSTED', 'UNKNOWN'] as const;

export type AgentSessionLocation = (typeof AGENT_SESSION_LOCATIONS)[number];

export const AGENT_SESSION_CHANNELS = [
  'HOOKS',
  'CONNECTOR',
  'GIT_INBOX',
  'HOSTED',
] as const;

export type AgentSessionChannel = (typeof AGENT_SESSION_CHANNELS)[number];

export const AGENT_SESSION_DRIVERS = ['TERMINAL', 'VANTIK'] as const;

export type AgentSessionDriver = (typeof AGENT_SESSION_DRIVERS)[number];

/**
 * The harnesses a session can name. The column is a string, because a harness
 * arrives without a migration. A name that is not in this list is recorded as
 * `other`.
 */
export const AGENT_SESSION_HARNESSES = [
  'omp',
  'pi',
  'claude-code',
  'codex',
  'cursor',
  'other',
] as const;

export type AgentSessionHarness = (typeof AGENT_SESSION_HARNESSES)[number];

/** The longest session id a harness can send. */
export const AGENT_SESSION_EXTERNAL_ID_MAX = 200;

export function normalizeAgentSessionHarness(
  value: string | null | undefined,
): AgentSessionHarness | null {
  const name = value?.trim().toLowerCase();

  if (!name) {
    return null;
  }

  return (AGENT_SESSION_HARNESSES as readonly string[]).includes(name)
    ? (name as AgentSessionHarness)
    : 'other';
}

const OMP_SESSION_UUID =
  /^(?:omp:)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * The id that `omp --resume` takes, or null when the session is not an omp
 * session on the person's machine. The hooks extension reports `omp:<uuid>`;
 * the connector reports the bare uuid. A hosted run, and a local run that has
 * not started omp yet, carry the run id as `externalId` and give null.
 */
export function ompResumeId(session: {
  externalId: string;
  harness: string | null;
  location: AgentSessionLocation;
  agentRunId?: string | null;
}): string | null {
  if (session.harness !== 'omp' || session.location !== 'LOCAL') {
    return null;
  }

  const id = OMP_SESSION_UUID.exec(session.externalId)?.[1];

  return id && id !== session.agentRunId ? id.toLowerCase() : null;
}

/**
 * Who drives the session now. A lease that ran out counts as nobody: the
 * connector renews it, so an old one means the connector is gone. A driver
 * with no lease at all was set by a channel that has no lease (the hooks, a
 * run in progress), and counts as set.
 */
export function effectiveDriver(
  session: {
    driver: AgentSessionDriver | null;
    driverLeaseExpiresAt: Date | string | null;
  },
  now: Date = new Date(),
): AgentSessionDriver | null {
  if (!session.driver) {
    return null;
  }

  if (!session.driverLeaseExpiresAt) {
    return session.driver;
  }

  return new Date(session.driverLeaseExpiresAt).getTime() > now.getTime()
    ? session.driver
    : null;
}

export class AgentSession {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  deleted: Date | null;

  workspaceId: string;
  issueId: string;
  /** The identity the session acts as. */
  actorUserId: string;

  /** The harness's own session id. For a hosted run, the run id. */
  externalId: string;
  harness: string | null;
  location: AgentSessionLocation;
  channel: AgentSessionChannel;

  driver: AgentSessionDriver | null;
  driverLeaseExpiresAt: Date | null;

  /** The session this one forked from. */
  parentSessionId: string | null;
  /** Set for a hosted session. */
  agentRunId: string | null;

  startedAt: Date;
  lastActiveAt: Date;
  endedAt: Date | null;
}

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

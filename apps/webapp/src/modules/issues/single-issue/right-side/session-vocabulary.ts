import { effectiveDriver, ompResumeId } from '@vantikhq/types';

/**
 * The words the issue page uses about an agent session.
 *
 * A session row carries plain strings, because a newer server can add a
 * harness or a channel. A value this bundle does not know is shown as it
 * arrives, so a new channel reads as itself and not as a blank.
 */

const HARNESS_LABEL: Record<string, string> = {
  omp: 'OMP',
  pi: 'Pi',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  other: 'Other harness',
};

const LOCATION_LABEL: Record<string, string> = {
  LOCAL: 'Local',
  HOSTED: 'Hosted',
  UNKNOWN: 'Unknown location',
};

const CHANNEL_LABEL: Record<string, string> = {
  HOOKS: 'Hooks',
  CONNECTOR: 'Connector',
  GIT_INBOX: 'Git inbox',
  HOSTED: 'Hosted run',
};

const DRIVER_LABEL: Record<string, string> = {
  TERMINAL: 'In your terminal',
  VANTIK: 'Vantik is driving',
};

interface SessionLike {
  id: string;
  harness?: string | null;
  location: string;
  channel: string;
  driver?: string | null;
  driverLeaseExpiresAt?: string | null;
  endedAt?: string | null;
  terminalTurns?: number | null;
  lastActiveAt?: string | null;
}

export const harnessLabel = (harness?: string | null) =>
  harness ? (HARNESS_LABEL[harness] ?? harness) : 'Unknown harness';

export const locationLabel = (location: string) =>
  LOCATION_LABEL[location] ?? location;

export const channelLabel = (channel: string) =>
  CHANNEL_LABEL[channel] ?? channel;

export const driverLabel = (driver?: string | null) =>
  driver ? (DRIVER_LABEL[driver] ?? driver) : null;

/**
 * Who drives the session now, in words, or null when nobody does. A lease that
 * ran out means the connector stopped saying, and a session that ended has no
 * driver. A driver this bundle does not know shows as it arrives.
 */
export function drivenBy(
  session: SessionLike,
  now: Date = new Date(),
): string | null {
  if (session.endedAt) {
    return null;
  }

  const driver = effectiveDriver(
    {
      driver: (session.driver ?? null) as 'TERMINAL' | 'VANTIK' | null,
      driverLeaseExpiresAt: session.driverLeaseExpiresAt ?? null,
    },
    now,
  );

  return driverLabel(driver);
}

/**
 * What a person did in their own terminal in this session: the turns it took
 * and when it was last active. Null when nothing came from a terminal, so a
 * session that was never resumed reads as before.
 */
export function terminalActivity(
  session?: SessionLike | null,
): { turns: number; lastActiveAt: string | null } | null {
  const turns = session?.terminalTurns ?? 0;

  return session && turns > 0
    ? { turns, lastActiveAt: session.lastActiveAt ?? null }
    : null;
}

/**
 * The shell command that continues an omp session on the person's machine, or
 * null when the session is not one. omp keys its sessions by the directory they
 * ran in, so a connector run, which ran in a worktree, starts with `cd`.
 */
export function resumeCommand(
  session: SessionLike & { externalId: string; agentRunId?: string | null },
  worktreePath?: string | null,
): string | null {
  const id = ompResumeId({
    externalId: session.externalId,
    harness: session.harness ?? null,
    location: session.location as 'LOCAL' | 'HOSTED' | 'UNKNOWN',
    agentRunId: session.agentRunId,
  });

  if (!id) {
    return null;
  }

  const resume = `omp --resume ${id}`;

  return worktreePath ? `cd ${shellQuote(worktreePath)} && ${resume}` : resume;
}

/** Quotes a path for a shell only when it needs it. */
const shellQuote = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

/** The first characters of an id, enough to tell two sessions apart. */
export const shortId = (id: string) => id.slice(0, 6);

/** "Claude Code · Local": the line that says what the session is. */
export const sessionTitle = (session: SessionLike) =>
  `${harnessLabel(session.harness)} · ${locationLabel(session.location)}`;

/** "Hooks · Terminal": how it reaches Vantik, and who drives it. */
export const sessionRoute = (session: SessionLike, now?: Date) =>
  [channelLabel(session.channel), drivenBy(session, now)]
    .filter(Boolean)
    .join(' · ');

/** "continued from Claude Code · a1b2c3", or null for a session with no parent. */
export function continuedFrom(
  session: { parentSessionId?: string | null },
  parent?: SessionLike,
): string | null {
  if (!session.parentSessionId) {
    return null;
  }

  return parent
    ? `continued from ${harnessLabel(parent.harness)} · ${shortId(parent.id)}`
    : `continued from ${shortId(session.parentSessionId)}`;
}

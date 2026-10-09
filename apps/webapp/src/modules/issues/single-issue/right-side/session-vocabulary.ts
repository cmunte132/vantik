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
  TERMINAL: 'Terminal',
  VANTIK: 'Vantik',
};

interface SessionLike {
  id: string;
  harness?: string | null;
  location: string;
  channel: string;
  driver?: string | null;
}

export const harnessLabel = (harness?: string | null) =>
  harness ? (HARNESS_LABEL[harness] ?? harness) : 'Unknown harness';

export const locationLabel = (location: string) =>
  LOCATION_LABEL[location] ?? location;

export const channelLabel = (channel: string) =>
  CHANNEL_LABEL[channel] ?? channel;

export const driverLabel = (driver?: string | null) =>
  driver ? (DRIVER_LABEL[driver] ?? driver) : null;

/** The first characters of an id, enough to tell two sessions apart. */
export const shortId = (id: string) => id.slice(0, 6);

/** "Claude Code · Local": the line that says what the session is. */
export const sessionTitle = (session: SessionLike) =>
  `${harnessLabel(session.harness)} · ${locationLabel(session.location)}`;

/** "Hooks · Terminal": how it reaches Vantik, and who drives it. */
export const sessionRoute = (session: SessionLike) =>
  [channelLabel(session.channel), driverLabel(session.driver)]
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

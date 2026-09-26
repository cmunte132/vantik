/**
 * What the hooks say to the agent.
 *
 * Written for a model reading them cold in the middle of a session: each names
 * the issue, says what is out of date, and says what to do about it with the
 * tools it already has. Kept apart from the rules so a change to the wording is
 * reviewed as one.
 */
export interface InProgressIssue {
  id: string;
  /** ENG-42. */
  key: string;
  title: string;
  criteria: { completed: number; total: number };
  /** The last time this agent recorded anything on it, in ms. */
  lastWrite: number | null;
}

/**
 * The session brief: what this agent already has in progress.
 *
 * Deliberately not a knowledge dump. `load_context` counts what it serves as
 * demand, and demand decides what survives decay and what shows up as a gap —
 * a hook asking on every session start, with a query nobody chose, would keep
 * entries alive that nobody reads. The agent is pointed at it instead, for the
 * area it is actually about to touch.
 */
export function sessionBrief(issues: InProgressIssue[], now: number): string {
  if (issues.length === 0) {
    return (
      'Vantik: nothing is in progress under your name. Before substantial ' +
      'work, find or file its issue (search_tasks), read its Definition of ' +
      'Done (get_task), and pick_up_task before the first edit. Before ' +
      'reading code in an area new to you, call load_context with that area.'
    );
  }

  const lines = issues.map((issue) => `- ${describe(issue, now)}`);

  return [
    `Vantik: you have ${count(issues.length, 'issue')} in progress.`,
    ...lines,
    'If this session works on one of them, keep it current as you go: ' +
      'update_criteria to tick each criterion the moment it is met, add_note ' +
      'when the approach changes or you stop, and close_task with a ' +
      'resolution when it is done. If this session is about something else, ' +
      'leave them be. Before reading code in an area new to you, call ' +
      'load_context with that area.',
  ].join('\n');
}

/**
 * Why the agent is not allowed to stop yet — said once per quiet stretch.
 *
 * It offers a way out on purpose. The hook cannot tell a session that worked
 * on an issue from one that never touched it, so a session that did not is told
 * to say so in a line; asking it to invent progress would be worse than the
 * silence this exists to catch.
 */
export function stopReason(
  issues: Array<InProgressIssue & { quietSince: number }>,
  now: number,
): string {
  const lines = issues.map(
    (issue) =>
      `- ${issue.key} ${issue.title}: ${progress(issue)}; nothing recorded ` +
      `on it for ${duration(now - issue.quietSince)}.`,
  );

  const one = issues.length === 1;

  return [
    one
      ? 'Before you stop: this issue is in progress under your name and has gone quiet.'
      : 'Before you stop: these issues are in progress under your name and have gone quiet.',
    ...lines,
    `If this session worked on ${one ? 'it' : 'one of them'}, record where ` +
      'it stands now: update_criteria for each criterion that is met, ' +
      'add_note with what changed and what is next, or close_task with a ' +
      `resolution if it is done. If this session did not touch ${one ? 'it' : 'them'}, ` +
      'say so in one line and stop. Vantik asks this once for each quiet ' +
      'stretch.',
  ].join('\n');
}

function describe(issue: InProgressIssue, now: number): string {
  const touched =
    issue.lastWrite === null
      ? 'you have not updated it'
      : `your last update was ${duration(now - issue.lastWrite)} ago`;

  return `${issue.key} ${issue.title}: ${progress(issue)}; ${touched}.`;
}

function progress({ criteria }: InProgressIssue): string {
  return criteria.total === 0
    ? 'no Definition of Done'
    : `${criteria.completed} of ${count(criteria.total, 'criterion', 'criteria')} met`;
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Coarse on purpose: "about when", for a reader deciding what to do. */
export function duration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));

  if (minutes < 90) {
    return count(minutes, 'minute');
  }

  const hours = Math.round(minutes / 60);

  if (hours < 48) {
    return count(hours, 'hour');
  }

  return count(Math.round(hours / 24), 'day');
}

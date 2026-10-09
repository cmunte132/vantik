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
  /** True when the issue is in a review state and waits for a person. */
  inReview: boolean;
  /** The name of the review state of its team, or null if the team has none. */
  reviewState: string | null;
  /** The last note from someone other than this agent, in ms. */
  lastReply: number | null;
}

/** True when the issue has a Definition of Done and every criterion is met. */
export function isComplete({ criteria }: InProgressIssue): boolean {
  return criteria.total > 0 && criteria.completed === criteria.total;
}

/**
 * This text tells the agent who closes an issue after a review, and when.
 *
 * Without it, an agent treats an issue in review as the business of the
 * person, and the issue stays open after the person approves it.
 */
const REVIEW_ENDS =
  'A review ends when a person approves the issue (in chat, in a note, or ' +
  'with a tick on the last criterion) or asks for changes. After an ' +
  'approval, close_task with a resolution yourself. Do not wait for the ' +
  'person to close it. After a request for changes, pick_up_task moves the ' +
  'issue back to in progress.';

/**
 * This text tells the agent when to give an issue to review.
 *
 * Without it, an agent has only two outcomes: close the issue, or leave it
 * in progress. When only a person can do the remainder, the agent then holds
 * the issue in progress, and the board does not show that it waits.
 */
function handToReview(issues: InProgressIssue[]): string {
  const names = [
    ...new Set(
      issues
        .map((issue) => issue.reviewState)
        .filter((name): name is string => name !== null),
    ),
  ];

  if (names.length === 0) {
    return '';
  }

  const state =
    names.length === 1 ? `"${names[0]}"` : 'the review state of its team';

  return (
    ' If every criterion is met, close_task: review is not for finished ' +
    'work. If your part is done and open criteria need a person (review or ' +
    `verification), update_task to ${state} and add_note with what to ` +
    'review. Do not leave it in progress.'
  );
}

/**
 * The brief asks for knowledge while the agent works. At the stop, the agent
 * has forgotten the details, or a compaction has discarded them.
 */
const RECORD_AS_YOU_GO =
  'When you learn something the next session would otherwise have to ' +
  'learn again (a decision and its reason, a gotcha, a convention, how a ' +
  'part of the system actually works), record it then with remember, one ' +
  'fact per call.';

/**
 * The session brief: what this agent already has in progress.
 *
 * Deliberately not a knowledge dump. `load_context` counts what it serves as
 * demand, and demand decides what survives decay and what shows up as a gap —
 * a hook asking on every session start, with a query nobody chose, would keep
 * entries alive that nobody reads. The agent is pointed at it instead, for the
 * area it is actually about to touch.
 *
 * The brief lists the issues in a review state apart from the others, and it
 * says how a review ends. An issue with every criterion met is marked as ready
 * to close, in either list.
 */
export function sessionBrief(
  issues: InProgressIssue[],
  now: number,
  sessionId?: string | null,
): string {
  const session = sessionLine(sessionId);
  const active = issues.filter((issue) => !issue.inReview);
  const waiting = issues.filter((issue) => issue.inReview);

  const review =
    waiting.length === 0
      ? []
      : [
          `Awaiting review: ${count(waiting.length, 'issue')} under your name. ${REVIEW_ENDS}`,
          ...waiting.map((issue) => `- ${describeReview(issue, now)}`),
        ];

  if (active.length === 0) {
    return [
      'Vantik: nothing is in progress under your name. Before substantial ' +
        'work, find or file its issue (search_tasks), read its Definition of ' +
        'Done (get_task), and pick_up_task before the first edit. Before ' +
        `reading code in an area new to you, call load_context with that area. ${RECORD_AS_YOU_GO}`,
      ...review,
      session,
    ]
      .filter(Boolean)
      .join('\n');
  }

  const lines = active.map((issue) => `- ${describe(issue, now)}`);
  const ready = active.some(isComplete)
    ? [
        'An issue marked ready to close has every criterion met. Close it ' +
          'with close_task and a resolution, unless something is still open.',
      ]
    : [];

  return [
    `Vantik: you have ${count(active.length, 'issue')} in progress.`,
    ...lines,
    ...ready,
    'If this session works on one of them, keep it current as you go: ' +
      'update_criteria to tick each criterion the moment it is met, add_note ' +
      'when the approach changes or you stop, and close_task with a ' +
      `resolution when it is done.${handToReview(active)} If this session ` +
      'is about something else, leave them be. Before reading code in an ' +
      `area new to you, call load_context with that area. ${RECORD_AS_YOU_GO}`,
    ...review,
    session,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The line that links this session to the issue it works on. The hooks do not
 * know the issue, so the agent says it when it picks the issue up. A session
 * id that cannot be a valid parameter is left out.
 */
function sessionLine(sessionId?: string | null): string | null {
  if (!sessionId || sessionId.length > 200 || /\s/.test(sessionId)) {
    return null;
  }

  return (
    `Your Vantik session id is ${sessionId}. When you pick_up_task, pass it ` +
    'as the session parameter. Vantik then shows this session on the issue.'
  );
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
      `resolution if it is done.${handToReview(issues)} ` +
      `If this session did not touch ${one ? 'it' : 'them'}, ` +
      'say so in one line and stop. Vantik asks this once for each quiet ' +
      'stretch.',
  ].join('\n');
}

/**
 * This message holds up a stop when the agent wrote to an issue in this
 * session, every criterion of the issue is met, and the issue is still open.
 *
 * The agent ticks the last criterion and then often stops with the issue open.
 * A person must then close it by hand. The message gives a way out, because a
 * person can still have to approve the work.
 */
export function closeReason(issues: InProgressIssue[]): string {
  const one = issues.length === 1;

  return [
    `Before you stop: every criterion is met on ${one ? 'this issue' : 'these issues'}, ` +
      `and ${one ? 'it is' : 'they are'} still open.`,
    ...issues.map(
      (issue) =>
        `- ${issue.key} ${issue.title}: ${progress(issue)}; ` +
        `${issue.inReview ? 'awaiting review' : 'in progress'}.`,
    ),
    'If nothing is left to do, close_task with a resolution now. If a ' +
      'person must still approve it, make sure it is in review and say in ' +
      'one line what they must check. Vantik asks this once for each issue ' +
      'in a session.',
  ].join('\n');
}

function describe(issue: InProgressIssue, now: number): string {
  const touched =
    issue.lastWrite === null
      ? 'you have not updated it'
      : `your last update was ${duration(now - issue.lastWrite)} ago`;
  const ready = isComplete(issue) ? '; ready to close' : '';

  return `${issue.key} ${issue.title}: ${progress(issue)}${ready}; ${touched}.`;
}

function describeReview(issue: InProgressIssue, now: number): string {
  const replied =
    issue.lastReply !== null && issue.lastReply > (issue.lastWrite ?? 0)
      ? `; a person replied ${duration(now - issue.lastReply)} ago, after your last update`
      : '';
  const ready = isComplete(issue) ? '; ready to close' : '';

  return `${issue.key} ${issue.title}: ${progress(issue)}${ready}${replied}.`;
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

/**
 * This message holds up a stop when the session changed files and nothing is
 * in progress under the name of the agent.
 *
 * The message gives a way out. The hook cannot know if the change is too
 * small for an issue, or if the repository uses Vantik at all. The agent
 * knows, and one line from it costs less than an issue that nobody needs.
 */
export function untrackedStopReason(edits: number): string {
  return [
    `Before you stop: this session changed files ${count(edits, 'time')}, ` +
      'and nothing is in progress under your name in Vantik.',
    'If the tracker should know about this work, find its issue ' +
      '(search_tasks) or file one (create_task), pick_up_task, and record ' +
      'what you did: update_criteria for each criterion that is met, add_note ' +
      'with what changed and what is next, or close_task with a resolution if ' +
      'it is done. If the change is too small to track, or this repository ' +
      'does not use Vantik, say so in one line and stop. Vantik asks this ' +
      'once for each session.',
  ].join('\n');
}

/**
 * This message holds up a stop when the session changed files many times and
 * the agent wrote nothing to the knowledge bank.
 *
 * It asks for facts, not for a report. A summary of the work belongs on the
 * issue, and a knowledge bank full of summaries is a knowledge bank that
 * nobody searches. It also asks the agent to correct the entries that the
 * work made false, because a stale entry is worse than no entry.
 *
 * The message gives a way out. Much work teaches nothing new, and one line
 * from the agent costs less than an entry that says nothing.
 */
export function knowledgeStopReason(
  edits: number,
  { also = false }: { also?: boolean } = {},
): string {
  return [
    `${also ? 'Also' : 'Before you stop'}: this session changed files ` +
      `${count(edits, 'time')} and recorded nothing in the Vantik knowledge ` +
      'bank.',
    'What did this work teach that the next session would otherwise have to ' +
      'learn again? Record each thing with remember, one fact per call, ' +
      'scoped to where it applies and citing the code or issue it rests on: ' +
      'a decision and its reason, a gotcha that cost time, a convention a ' +
      'newcomer would not guess, how a part of the system actually works. ' +
      'If this session changed behaviour that the bank describes (check with ' +
      'load_context for the area), record the new behaviour and supersede ' +
      'the entry it replaces. Do not record a summary of what you did; that ' +
      'belongs on the issue. If nothing here is worth keeping, say so in one ' +
      'line and stop.',
  ].join('\n');
}

/** A page of the knowledge bank that matched a prompt. */
export interface KnowledgePointer {
  title: string;
  /** How many of its documents, the page body and its entries, matched. */
  matches: number;
  scope: string | null;
}

/**
 * This message tells the agent which pages of the knowledge bank match the
 * prompt. It gives the titles only.
 *
 * The contents stay out on purpose. `load_context` counts what it serves as
 * demand, and a hook that served content for each prompt would keep entries
 * alive that nobody read. So the hook names the pages, and the agent loads
 * them if the work needs them.
 */
export function knowledgePointers(pointers: KnowledgePointer[]): string {
  const lines = pointers.map((pointer) => {
    const where = pointer.scope ? `, scope ${pointer.scope}` : '';
    return `- "${pointer.title}" (${count(pointer.matches, 'match', 'matches')}${where})`;
  });

  return [
    'Vantik: the knowledge bank has pages that match this prompt.',
    ...lines,
    'Before you rely on your own reading of the code in this area, call ' +
      'load_context with a task that describes this work. These are titles ' +
      'only: Vantik loaded none of their content.',
  ].join('\n');
}

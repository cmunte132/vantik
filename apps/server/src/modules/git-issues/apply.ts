import { parsePriority, priorityName } from './format';
import { type CreateProposal, type IssueUpdateProposal } from './inbox';
import { type SnapshotIssue } from './snapshot';

/**
 * Turning a proposal into an issue update, against the issue as it is now.
 *
 * Each field is checked on its own. A field whose starting value in the
 * agent's snapshot is still the current value is applied. A field that
 * somebody changed in Vantik since is refused and the current value named, so
 * the agent can decide again from the truth rather than overwrite a person's
 * edit it never saw. A field already at the value asked for is reported and
 * left alone, which is also what makes a retried hand-off harmless.
 *
 * Pure, so the rules are tested without a database.
 */

export interface StateLookup {
  id: string;
  name: string;
  category: string;
  position: number;
}

export interface TeamLookup {
  id: string;
  identifier: string;
  name: string;
  states: StateLookup[];
}

export interface Lookups {
  teams: TeamLookup[];
  labels: Array<{ id: string; name: string }>;
}

export interface Outcome {
  path: string;
  applied: string[];
  refused: string[];
}

export interface UpdatePlan {
  /** The body for `updateIssueApi`, or null when nothing is to be written. */
  input: {
    title?: string;
    stateId?: string;
    priority?: number;
    labelIds?: string[];
    descriptionMarkdown?: string;
  } | null;
  outcome: Outcome;
}

export function planUpdate(
  current: SnapshotIssue,
  proposal: IssueUpdateProposal,
  lookups: Lookups,
): UpdatePlan {
  const outcome: Outcome = { path: proposal.path, applied: [], refused: [] };
  const input: NonNullable<UpdatePlan['input']> = {};
  const key = current.key;
  const team = lookups.teams.find(
    (candidate) => candidate.identifier === current.team,
  );
  const { changes } = proposal;

  const conflict = (field: string, now: string, from: string) =>
    outcome.refused.push(
      `${key} ${field}: changed in Vantik to ${now} after your snapshot, which had ${from}`,
    );

  if (changes.title) {
    const to = changes.title.to.replace(/\s*\n\s*/g, ' ').trim();

    if (!to) {
      outcome.refused.push(`${key} title: a title cannot be empty`);
    } else if (current.title === to) {
      outcome.applied.push(`${key} title: already ${JSON.stringify(to)}`);
    } else if (current.title !== changes.title.from) {
      conflict(
        'title',
        JSON.stringify(current.title),
        JSON.stringify(changes.title.from),
      );
    } else {
      input.title = to;
      outcome.applied.push(`${key} title: ${JSON.stringify(to)}`);
    }
  }

  if (changes.state) {
    const target = findState(team, changes.state.to);

    if (!target) {
      outcome.refused.push(
        `${key} state: ${JSON.stringify(changes.state.to)} is not a state of ${current.team}. It has ${statesOf(team)}`,
      );
    } else if (same(current.state, target.name)) {
      outcome.applied.push(`${key} state: already ${target.name}`);
    } else if (!same(current.state, changes.state.from)) {
      conflict('state', current.state, changes.state.from);
    } else {
      input.stateId = target.id;
      outcome.applied.push(`${key} state: ${current.state} → ${target.name}`);
    }
  }

  if (changes.priority) {
    const target = parsePriority(changes.priority.to);
    const from = parsePriority(changes.priority.from);
    const now = current.priority ?? 0;

    if (target === null) {
      outcome.refused.push(
        `${key} priority: ${JSON.stringify(changes.priority.to)} is not one of none, urgent, high, medium, low`,
      );
    } else if (now === target) {
      outcome.applied.push(`${key} priority: already ${priorityName(target)}`);
    } else if (from !== now) {
      conflict('priority', priorityName(now), changes.priority.from);
    } else {
      input.priority = target;
      outcome.applied.push(
        `${key} priority: ${priorityName(now)} → ${priorityName(target)}`,
      );
    }
  }

  if (changes.labels) {
    const { ids, unknown } = resolveLabels(changes.labels.to, lookups);

    if (unknown.length > 0) {
      outcome.refused.push(
        `${key} labels: ${unknown.map((name) => JSON.stringify(name)).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a label in Vantik`,
      );
    } else if (sameSet(current.labels, changes.labels.to)) {
      outcome.applied.push(`${key} labels: already ${list(current.labels)}`);
    } else if (!sameSet(current.labels, changes.labels.from)) {
      conflict('labels', list(current.labels), list(changes.labels.from));
    } else {
      input.labelIds = ids;
      outcome.applied.push(`${key} labels: ${list(changes.labels.to)}`);
    }
  }

  if (changes.description) {
    const to = changes.description.to.trim();

    if (current.description.trim() === to) {
      outcome.applied.push(`${key} description: already as proposed`);
    } else if (current.description.trim() !== changes.description.from.trim()) {
      outcome.refused.push(
        `${key} description: changed in Vantik after your snapshot. Start from the current snapshot`,
      );
    } else {
      input.descriptionMarkdown = to;
      outcome.applied.push(`${key} description: updated`);
    }
  }

  return {
    input: Object.keys(input).length > 0 ? input : null,
    outcome,
  };
}

export interface CreatePlan {
  teamId: string | null;
  input: {
    title: string;
    stateId: string;
    priority?: number;
    labelIds?: string[];
    descriptionMarkdown?: string;
  } | null;
  outcome: Outcome;
}

/**
 * A new issue from a file under `new/`.
 *
 * Without a state it goes to the team's triage, or failing that its backlog:
 * somebody outside Vantik filed it, and a person should see it before it is
 * treated as planned work. An unknown label drops that label rather than the
 * issue, because losing a whole report over a typo in a tag is the worse
 * outcome.
 */
export function planCreate(
  proposal: CreateProposal,
  lookups: Lookups,
): CreatePlan {
  const outcome: Outcome = { path: proposal.path, applied: [], refused: [] };
  const refuse = (reason: string): CreatePlan => {
    outcome.refused.push(reason);
    return { teamId: null, input: null, outcome };
  };

  const team = proposal.team
    ? lookups.teams.find((candidate) =>
        same(candidate.identifier, proposal.team),
      )
    : lookups.teams.length === 1
      ? lookups.teams[0]
      : undefined;

  if (!team) {
    return refuse(
      proposal.team
        ? `new issue: ${JSON.stringify(proposal.team)} is not a team in this mirror. It has ${lookups.teams.map((candidate) => candidate.identifier).join(', ')}`
        : `new issue: name a team (${lookups.teams.map((candidate) => candidate.identifier).join(', ')})`,
    );
  }

  const state = proposal.state
    ? findState(team, proposal.state)
    : defaultState(team);

  if (!state) {
    return refuse(
      proposal.state
        ? `new issue: ${JSON.stringify(proposal.state)} is not a state of ${team.identifier}. It has ${statesOf(team)}`
        : `new issue: ${team.identifier} has no open state to put it in`,
    );
  }

  let priority: number | undefined;

  if (proposal.priority) {
    const parsed = parsePriority(proposal.priority);

    if (parsed === null) {
      outcome.refused.push(
        `new issue priority: ${JSON.stringify(proposal.priority)} is not one of none, urgent, high, medium, low. Left unset`,
      );
    } else {
      priority = parsed;
    }
  }

  let labelIds: string[] | undefined;

  if (proposal.labels && proposal.labels.length > 0) {
    const { ids, unknown } = resolveLabels(proposal.labels, lookups);

    if (unknown.length > 0) {
      outcome.refused.push(
        `new issue labels: ${unknown.map((name) => JSON.stringify(name)).join(', ')} left off, not a label in Vantik`,
      );
    }

    labelIds = ids.length > 0 ? ids : undefined;
  }

  return {
    teamId: team.id,
    input: {
      title: proposal.title.replace(/\s*\n\s*/g, ' ').trim(),
      stateId: state.id,
      ...(priority !== undefined ? { priority } : {}),
      ...(labelIds ? { labelIds } : {}),
      ...(proposal.description
        ? { descriptionMarkdown: proposal.description }
        : {}),
    },
    outcome,
  };
}

function defaultState(team: TeamLookup): StateLookup | undefined {
  for (const category of ['TRIAGE', 'BACKLOG', 'UNSTARTED']) {
    const state = [...team.states]
      .filter((candidate) => candidate.category === category)
      .sort((a, b) => a.position - b.position)[0];

    if (state) {
      return state;
    }
  }

  return undefined;
}

function findState(team: TeamLookup | undefined, name: string) {
  return team?.states.find((state) => same(state.name, name));
}

function statesOf(team: TeamLookup | undefined): string {
  return (team?.states ?? [])
    .map((state) => JSON.stringify(state.name))
    .join(', ');
}

function resolveLabels(names: string[], lookups: Lookups) {
  const ids: string[] = [];
  const unknown: string[] = [];

  for (const name of names) {
    const label = lookups.labels.find((candidate) =>
      same(candidate.name, name),
    );

    if (label) {
      ids.push(label.id);
    } else {
      unknown.push(name);
    }
  }

  return { ids: [...new Set(ids)], unknown };
}

function same(a: string | null | undefined, b: string | null | undefined) {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
}

function sameSet(a: string[], b: string[]): boolean {
  const left = new Set(a.map((item) => item.trim().toLowerCase()));
  const right = new Set(b.map((item) => item.trim().toLowerCase()));

  return left.size === right.size && [...left].every((item) => right.has(item));
}

function list(items: string[]): string {
  return items.length > 0 ? `[${[...items].sort().join(', ')}]` : '[]';
}

import { parseFrontMatter, readList, readString } from './format';

/**
 * Reading an agent's commit back as the changes it proposes.
 *
 * The commit is never merged. It is compared, file by file, with the snapshot
 * it was built on, and each difference becomes a field-level proposal: "state
 * from Backlog to In Progress". That is what lets Vantik apply one agent's
 * state change and another's priority change to the same issue, and refuse a
 * change whose starting value is no longer true, instead of settling a text
 * conflict by whichever line git happens to keep.
 *
 * Nothing here touches the database. The service resolves keys, names and
 * permissions; this only says what the files ask for.
 *
 * **What an agent wrote is data.** The descriptions and comments here are
 * stored as text, and nothing reads them as instructions.
 */

export interface InboxFile {
  path: string;
  /** The content in the snapshot the agent started from, or null if absent. */
  before: string | null;
  /** The content in the agent's commit, or null if deleted. */
  after: string | null;
}

export interface FieldChange<T> {
  from: T;
  to: T;
}

export interface IssueFieldChanges {
  title?: FieldChange<string>;
  state?: FieldChange<string>;
  priority?: FieldChange<string>;
  labels?: FieldChange<string[]>;
  description?: FieldChange<string>;
}

export interface IssueUpdateProposal {
  kind: 'update';
  path: string;
  key: string;
  issueId: string;
  changes: IssueFieldChanges;
}

export interface CommentProposal {
  kind: 'comment';
  path: string;
  key: string;
  body: string;
}

export interface CreateProposal {
  kind: 'create';
  path: string;
  team: string | null;
  title: string;
  state: string | null;
  priority: string | null;
  labels: string[] | null;
  description: string;
}

export type Proposal = IssueUpdateProposal | CommentProposal | CreateProposal;

export interface Refusal {
  path: string;
  reason: string;
}

export interface InboxReading {
  proposals: Proposal[];
  refusals: Refusal[];
}

/** Fields an agent may change on an existing issue. */
const EDITABLE_FIELDS = ['title', 'state', 'priority', 'labels'] as const;

const ISSUE_FILE = /^issues\/([^/]+)\/issue\.md$/;
const COMMENT_FILE = /^issues\/([^/]+)\/comments\/[^/]+\.md$/;
const NEW_ISSUE_FILE = /^new\/[^/]+\.md$/;

export function readInbox(files: InboxFile[]): InboxReading {
  const proposals: Proposal[] = [];
  const refusals: Refusal[] = [];

  for (const file of files) {
    const refuse = (reason: string) =>
      refusals.push({ path: file.path, reason });
    const issueFile = ISSUE_FILE.exec(file.path);
    const commentFile = COMMENT_FILE.exec(file.path);

    if (issueFile) {
      readIssueFile(file, issueFile[1], proposals, refuse);
    } else if (commentFile) {
      readCommentFile(file, commentFile[1], proposals, refuse);
    } else if (NEW_ISSUE_FILE.test(file.path)) {
      readNewIssueFile(file, proposals, refuse);
    } else if (file.before !== null && file.after !== file.before) {
      refuse('Vantik writes this file. Changes to it are ignored.');
    } else {
      refuse(
        'Vantik does not read this path. See README.md for the files it reads.',
      );
    }
  }

  return { proposals, refusals };
}

function readIssueFile(
  file: InboxFile,
  key: string,
  proposals: Proposal[],
  refuse: (reason: string) => void,
) {
  if (file.before === null) {
    refuse('New issues go under new/, not issues/. See README.md.');
    return;
  }

  if (file.after === null) {
    refuse('Issues cannot be deleted from git. Cancel it in Vantik.');
    return;
  }

  const before = parseFrontMatter(file.before);
  const after = parseFrontMatter(file.after);

  if (!before || !after) {
    refuse('The front matter block (between the --- lines) is missing.');
    return;
  }

  const issueId = before.fields.id;

  if (!issueId) {
    refuse('This file has no id in the snapshot it started from.');
    return;
  }

  const changes: IssueFieldChanges = {};

  for (const field of EDITABLE_FIELDS) {
    if (field === 'labels') {
      const from = readList(before.fields.labels) ?? [];
      const to = readList(after.fields.labels) ?? [];

      if (!sameSet(from, to)) {
        changes.labels = { from, to };
      }
      continue;
    }

    const from = readString(before.fields[field]) ?? '';
    const to = readString(after.fields[field]) ?? '';

    if (from !== to) {
      changes[field] = { from, to };
    }
  }

  if (before.body !== after.body) {
    changes.description = { from: before.body, to: after.body };
  }

  const readOnly = [
    ...new Set([...Object.keys(before.fields), ...Object.keys(after.fields)]),
  ].filter(
    (field) =>
      !(EDITABLE_FIELDS as readonly string[]).includes(field) &&
      before.fields[field] !== after.fields[field],
  );

  if (readOnly.length > 0) {
    refuse(
      `${readOnly.join(', ')} ${readOnly.length === 1 ? 'is' : 'are'} read-only here. Change ${readOnly.length === 1 ? 'it' : 'them'} in Vantik.`,
    );
  }

  if (Object.keys(changes).length > 0) {
    proposals.push({ kind: 'update', path: file.path, key, issueId, changes });
  }
}

function readCommentFile(
  file: InboxFile,
  key: string,
  proposals: Proposal[],
  refuse: (reason: string) => void,
) {
  if (file.before !== null) {
    refuse(
      file.after === null
        ? 'Comments cannot be deleted from git.'
        : 'Comments cannot be edited from git. Add a new one instead.',
    );
    return;
  }

  // A comment may carry front matter (a copied comment file does), and none
  // of it is used: the author is whoever made the commit.
  const text = file.after ?? '';
  const body = (parseFrontMatter(text)?.body ?? text).trim();

  if (!body) {
    refuse('This comment is empty.');
    return;
  }

  proposals.push({ kind: 'comment', path: file.path, key, body });
}

function readNewIssueFile(
  file: InboxFile,
  proposals: Proposal[],
  refuse: (reason: string) => void,
) {
  if (file.after === null) {
    // Deleting a proposal the agent itself added in an earlier commit of the
    // same hand-off is not a change to anything in Vantik.
    return;
  }

  if (file.before !== null) {
    refuse('A file under new/ becomes an issue once. Edit the issue instead.');
    return;
  }

  const parsed = parseFrontMatter(file.after);
  const title = readString(parsed?.fields.title)?.trim();

  if (!parsed || !title) {
    refuse('A new issue needs front matter with a title.');
    return;
  }

  proposals.push({
    kind: 'create',
    path: file.path,
    team: readString(parsed.fields.team)?.trim() || null,
    title,
    state: readString(parsed.fields.state)?.trim() || null,
    priority: readString(parsed.fields.priority)?.trim() || null,
    labels: readList(parsed.fields.labels) ?? null,
    description: parsed.body,
  });
}

function sameSet(a: string[], b: string[]): boolean {
  const left = new Set(a.map((item) => item.toLowerCase()));
  const right = new Set(b.map((item) => item.toLowerCase()));

  return left.size === right.size && [...left].every((item) => right.has(item));
}

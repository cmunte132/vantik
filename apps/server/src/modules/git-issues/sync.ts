import { type Outcome } from './apply';
import { type CommitInfo, type GitIdentity, type GitRepository } from './git';
import { type InboxFile, type InboxReading, readInbox } from './inbox';
import { renderSnapshot, type Snapshot } from './snapshot';

/**
 * One pass over one repository: read what agents handed in, apply it, and
 * write the snapshot they read.
 *
 * The refs:
 *
 * - `refs/vantik/issues` is Vantik's. Agents read it and never write it.
 * - `refs/vantik/inbox/<name>` is one per hand-off. An agent writes it, Vantik
 *   reads it once and deletes it.
 *
 * Splitting them is what lets many agents work at once. A single shared ref
 * would make every agent after the first lose a race and merge; a ref each
 * cannot collide, and Vantik is the only thing that ever combines them.
 *
 * The inbox is applied before the snapshot is written, so the snapshot that
 * follows a hand-off already shows its effect, and its commit message carries
 * the outcome. That message is the only reply an agent gets: it has no other
 * way to hear from a Vantik it cannot reach.
 */

export const SNAPSHOT_REF = 'refs/vantik/issues';
export const INBOX_PREFIX = 'refs/vantik/inbox/';

export const VANTIK_IDENTITY: GitIdentity = {
  name: 'Vantik',
  email: 'vantik@vantik.local',
};

/** More than this in one hand-off is a mistake, not a proposal. */
export const MAX_INBOX_FILES = 200;
export const MAX_FILE_BYTES = 256 * 1024;

export interface HandOffSource {
  /** The inbox name, or `direct` for commits made on the snapshot ref itself. */
  name: string;
  commit: CommitInfo;
}

/** What the pass needs from Vantik for one repository. */
export interface MirrorStore {
  load(): Promise<Snapshot>;
  /** Applies what can be applied, and says what happened to each proposal. */
  apply(reading: InboxReading, source: HandOffSource): Promise<Outcome[]>;
}

export interface HandOff {
  name: string;
  commit: CommitInfo;
  outcomes: Outcome[];
}

export interface PassResult {
  /** Where the snapshot ref is after the pass. */
  tip: string | null;
  /** Whether this pass wrote a commit. */
  wrote: boolean;
  handOffs: HandOff[];
}

export async function syncRepository(
  git: GitRepository,
  store: MirrorStore,
  options: {
    /**
     * Asked when there was nothing to apply. True means the database has not
     * changed since this tip was written, so loading and rendering it again
     * would only prove that.
     */
    upToDate?: (tip: string | null) => Promise<boolean>;
    /**
     * An inbox that could not be applied, because the store failed rather
     * than because the proposal was wrong. Its ref stays, so the next pass
     * tries again, and it gets no reply yet: a reply every minute saying "not
     * yet" would be a commit every minute for as long as the fault lasts.
     */
    onInboxError?: (name: string, error: unknown) => void;
    now?: Date;
  } = {},
): Promise<PassResult> {
  const tip = await git.resolve(SNAPSHOT_REF);
  const handOffs: HandOff[] = [];

  if (tip) {
    const direct = await readDirectCommits(git, store, tip);

    if (direct) {
      handOffs.push(direct);
    }
  }

  for (const inbox of await git.refs(INBOX_PREFIX)) {
    const name = inbox.ref.slice(INBOX_PREFIX.length);
    const commit = await git.commit(inbox.sha);
    const base = tip ? await git.mergeBase(inbox.sha, tip) : null;

    let outcomes: Outcome[];

    try {
      outcomes = base
        ? await applyRange(git, store, base, inbox.sha, { name, commit })
        : [
            {
              path: '',
              applied: [],
              refused: [
                `this commit is not built on ${SNAPSHOT_REF}. Check that ref out and commit on top of it`,
              ],
            },
          ];
    } catch (error) {
      options.onInboxError?.(name, error);
      continue;
    }

    handOffs.push({ name, commit, outcomes });

    // Only if it has not moved. An agent that reused the name while this pass
    // ran has a newer commit there, which the next pass reads.
    await git.deleteRef(inbox.ref, inbox.sha);
  }

  if (
    handOffs.length === 0 &&
    options.upToDate &&
    (await options.upToDate(tip))
  ) {
    return { tip, wrote: false, handOffs };
  }

  const files = renderSnapshot(await store.load());
  const commit = await git.writeSnapshot({
    files,
    parent: tip,
    message: (changed) => snapshotMessage(changed, handOffs, tip === null),
    identity: VANTIK_IDENTITY,
    allowEmpty: handOffs.length > 0,
    date: options.now,
  });

  if (!commit) {
    return { tip, wrote: false, handOffs };
  }

  // Compare-and-swap. If the ref moved under this pass, somebody committed to
  // it directly; the next pass reads their commits and writes on top.
  const moved = await git.updateRef(SNAPSHOT_REF, commit, tip);

  return moved
    ? { tip: commit, wrote: true, handOffs }
    : { tip, wrote: false, handOffs };
}

/**
 * Commits somebody made on the snapshot ref itself, against the README's
 * advice.
 *
 * Writing a new snapshot over them would drop their work without a word, so
 * they are read as a hand-off named `direct`, from the last commit Vantik
 * wrote to the tip, and the next snapshot keeps them in its history.
 */
async function readDirectCommits(
  git: GitRepository,
  store: MirrorStore,
  tip: string,
): Promise<HandOff | null> {
  const chain = await git.firstParents(tip, 200);

  if (chain[0]?.committerEmail === VANTIK_IDENTITY.email) {
    return null;
  }

  const base = chain.find(
    (candidate) => candidate.committerEmail === VANTIK_IDENTITY.email,
  );

  if (!base) {
    throw new Error(
      `${SNAPSHOT_REF} in ${git.path} has no commit written by Vantik in its last 200. Something else owns that ref; not touching it`,
    );
  }

  const source = { name: 'direct', commit: chain[0] };

  return {
    ...source,
    outcomes: await applyRange(git, store, base.sha, tip, source),
  };
}

async function applyRange(
  git: GitRepository,
  store: MirrorStore,
  base: string,
  head: string,
  source: HandOffSource,
): Promise<Outcome[]> {
  const changes = await git.diff(base, head);

  if (changes.length === 0) {
    return [];
  }

  if (changes.length > MAX_INBOX_FILES) {
    return [
      {
        path: '',
        applied: [],
        refused: [
          `${changes.length} files changed; a hand-off can change at most ${MAX_INBOX_FILES}`,
        ],
      },
    ];
  }

  const paths = changes.map((change) => change.path);
  const [before, after] = await Promise.all([
    git.readFiles(base, paths),
    git.readFiles(head, paths),
  ]);

  const files: InboxFile[] = [];
  const tooLarge: Outcome[] = [];

  for (const path of paths) {
    const content = after.get(path) ?? null;

    if (content !== null && Buffer.byteLength(content) > MAX_FILE_BYTES) {
      tooLarge.push({
        path,
        applied: [],
        refused: [`larger than ${MAX_FILE_BYTES / 1024} KiB`],
      });
      continue;
    }

    files.push({ path, before: before.get(path) ?? null, after: content });
  }

  const reading = readInbox(files);
  const refusals = reading.refusals.map((refusal): Outcome => ({
    path: refusal.path,
    applied: [],
    refused: [refusal.reason],
  }));

  return [...tooLarge, ...refusals, ...(await store.apply(reading, source))];
}

/**
 * The commit message, which doubles as the reply to every hand-off.
 *
 * Each hand-off gets a paragraph, and a `Vantik-Inbox:` trailer an agent can
 * grep for. Paths come before reasons because the agent knows its files and
 * not Vantik's wording.
 */
export function snapshotMessage(
  changed: string[],
  handOffs: HandOff[],
  first: boolean,
): string {
  const keys = [
    ...new Set(
      changed
        .map((path) => /^issues\/([^/]+)\//.exec(path)?.[1])
        .filter((key): key is string => Boolean(key)),
    ),
  ];

  const subject = first
    ? `Vantik: first snapshot, ${keys.length} ${keys.length === 1 ? 'issue' : 'issues'}`
    : keys.length === 0
      ? 'Vantik: no issue changed'
      : keys.length <= 5
        ? `Vantik: update ${keys.join(', ')}`
        : `Vantik: update ${keys.length} issues`;

  const paragraphs = [subject];

  for (const handOff of handOffs) {
    const lines = [
      `Inbox ${handOff.name}, commit ${handOff.commit.sha.slice(0, 12)} by ${handOff.commit.authorName} <${handOff.commit.authorEmail}>:`,
    ];

    for (const outcome of handOff.outcomes) {
      const where = outcome.path ? `${outcome.path}: ` : '';

      lines.push(
        ...outcome.applied.map((line) => `- applied: ${line}`),
        ...outcome.refused.map((line) => `- refused: ${where}${line}`),
      );
    }

    if (lines.length === 1) {
      lines.push('- nothing to apply');
    }

    paragraphs.push(lines.join('\n'));
  }

  if (handOffs.length > 0) {
    paragraphs.push(
      handOffs.map((handOff) => `Vantik-Inbox: ${handOff.name}`).join('\n'),
    );
  }

  return `${paragraphs.join('\n\n')}\n`;
}

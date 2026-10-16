import { type Outcome } from './apply';
import {
  type CommitInfo,
  type FileReading,
  type GitIdentity,
  type GitRepository,
} from './git';
import { type InboxFile, type InboxReading, readInbox } from './inbox';
import {
  HostRefusedPushError,
  INBOX_PREFIX,
  type IssueRemote,
  SNAPSHOT_REF,
} from './issue-remote';
import { renderSnapshot, type Snapshot } from './snapshot';

export { INBOX_PREFIX, SNAPSHOT_REF };

/**
 * One pass over one repository: read what agents handed in, apply it, and
 * write the snapshot they read.
 *
 * All git work happens in the server's bare mirror of the repository. The
 * pass fetches the issue refs of the source into the mirror, and when it is
 * done it pushes the new snapshot back. See `IssueRemote` for the two pushes.
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
 *
 * The snapshot names each inbox commit that it absorbed as an extra parent.
 * An agent that commits again on top of its first hand-off is then compared
 * with that first commit and not with the first snapshot, so one change is
 * never applied twice.
 *
 * The pass deletes an inbox ref only after the push of the snapshot worked.
 * If the push fails, the ref stays, and the next pass applies the hand-off
 * again. That is safe, because every proposal is checked against the current
 * state of the issue and against what an earlier pass already wrote.
 */

export const VANTIK_IDENTITY: GitIdentity = {
  name: 'Vantik',
  email: 'vantik@vantik.local',
};

/** More than this in one hand-off is a mistake, not a proposal. */
export const MAX_INBOX_FILES = 200;
export const MAX_FILE_BYTES = 256 * 1024;
/** The most content that one hand-off can make the server read. */
export const MAX_INBOX_BYTES = 8 * 1024 * 1024;

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
  /** The commit that was read, or null when the ref did not point at one. */
  commit: CommitInfo | null;
  /** The object that the ref pointed at. */
  object: string;
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
  mirror: GitRepository,
  remote: IssueRemote,
  store: MirrorStore,
  options: {
    /**
     * Asked when there was nothing to apply. True means the database has not
     * changed since this tip was written, so loading and rendering it again
     * would only prove that.
     */
    upToDate?: (tip: string | null) => Promise<boolean>;
    /**
     * A fault that stops one inbox but not the pass. Either the store failed
     * rather than the proposal being wrong, or the inbox could not be deleted
     * at the source. The ref stays, so the next pass tries again. A store
     * failure gets no reply yet: a reply every minute that says "not yet" would
     * be a commit every minute for as long as the fault lasts.
     */
    onInboxError?: (name: string, error: unknown) => void;
    now?: Date;
  } = {},
): Promise<PassResult> {
  await remote.exclusive(() => remote.fetchRefs());

  const tip = await mirror.resolve(SNAPSHOT_REF);

  if (!tip && (await mirror.rawRef(SNAPSHOT_REF))) {
    throw new Error(
      `${SNAPSHOT_REF} in ${mirror.path} is not a commit. Something else owns that ref; not touching it`,
    );
  }

  const handOffs: HandOff[] = [];
  /** The inbox refs that were read, and that the pass deletes when it is done. */
  const handled: Array<{ ref: string; sha: string; name: string }> = [];
  /** The inbox commits that the next snapshot takes as extra parents. */
  const absorbed: string[] = [];

  if (tip) {
    const direct = await readDirectCommits(mirror, store, tip);

    if (direct) {
      handOffs.push(direct);
    }
  }

  for (const inbox of await mirror.refs(INBOX_PREFIX)) {
    const name = inbox.ref.slice(INBOX_PREFIX.length);
    const found = await locateInbox(mirror, inbox.sha, tip);
    let outcomes: Outcome[];

    if ('refusal' in found) {
      outcomes = [{ path: '', applied: [], refused: [found.refusal] }];
    } else {
      try {
        outcomes = await applyRange(mirror, store, found.base, inbox.sha, {
          name,
          commit: found.commit,
        });
        absorbed.push(inbox.sha);
      } catch (error) {
        options.onInboxError?.(name, error);
        continue;
      }
    }

    handOffs.push({
      name,
      commit: found.commit,
      object: inbox.sha,
      outcomes,
    });
    handled.push({ ...inbox, name });
  }

  if (
    handOffs.length === 0 &&
    options.upToDate &&
    (await options.upToDate(tip))
  ) {
    return { tip, wrote: false, handOffs };
  }

  const files = renderSnapshot(await store.load());

  return await remote.exclusive(async () => {
    const commit = await mirror.writeSnapshot({
      files,
      parent: tip,
      extraParents: absorbed.filter((sha) => sha !== tip),
      message: (changed) => snapshotMessage(changed, handOffs, tip === null),
      identity: VANTIK_IDENTITY,
      allowEmpty: handOffs.length > 0,
      date: options.now,
    });

    if (!commit) {
      return { tip, wrote: false, handOffs };
    }

    // Compare-and-swap, in the mirror and then at the source. If either ref
    // moved under this pass, somebody committed to it directly; the next pass
    // reads their commits and writes on top.
    if (!(await mirror.updateRef(SNAPSHOT_REF, commit, tip))) {
      return { tip, wrote: false, handOffs };
    }

    let pushed = false;

    try {
      pushed = await remote.pushSnapshot(commit, tip);
    } finally {
      if (!pushed) {
        // The source has no such commit, so the mirror must not say that it
        // does. The next fetch would force the same result.
        if (tip) {
          await mirror.updateRef(SNAPSHOT_REF, tip, commit);
        } else {
          await mirror.deleteRef(SNAPSHOT_REF, commit);
        }
      }
    }

    if (!pushed) {
      return { tip, wrote: false, handOffs };
    }

    // Only now, and only if the ref has not moved. An agent that reused the
    // name while this pass ran has a newer commit there, which the next pass
    // reads.
    for (const inbox of handled) {
      try {
        await remote.deleteInbox(inbox.ref, inbox.sha);
      } catch (error) {
        options.onInboxError?.(inbox.name, error);

        // The host refuses each delete for the same reason. One report is
        // enough, and the next pass tries again.
        if (error instanceof HostRefusedPushError) {
          break;
        }
      }

      await mirror.deleteRef(inbox.ref, inbox.sha);
    }

    return { tip: commit, wrote: true, handOffs };
  });
}

/**
 * Finds the commit of an inbox ref and the point where it left the snapshot.
 * It gives a reason instead when the ref cannot be a hand-off: it points at a
 * blob or a tree, the mirror has not got the object, or the commit is not
 * built on the snapshot.
 */
async function locateInbox(
  mirror: GitRepository,
  sha: string,
  tip: string | null,
): Promise<
  | { commit: CommitInfo; base: string }
  | { commit: CommitInfo | null; base: null; refusal: string }
> {
  let commit: CommitInfo | null = null;

  try {
    const type = await mirror.objectType(sha);

    if (type !== 'commit') {
      return {
        commit,
        base: null,
        refusal: `this ref points at ${type ? `a ${type}` : 'an object that is not there'}, not at a commit. Commit your changes, and point the ref at that commit`,
      };
    }

    commit = await mirror.commit(sha);
    const base = tip ? await mirror.mergeBase(sha, tip) : null;

    return base
      ? { commit, base }
      : {
          commit,
          base: null,
          refusal: `this commit is not built on ${SNAPSHOT_REF}. Check that ref out and commit on top of it`,
        };
  } catch (error) {
    return {
      commit,
      base: null,
      refusal: `this ref could not be read as a commit: ${String(error).slice(0, 200)}`,
    };
  }
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
    object: chain[0].sha,
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
  const limits = {
    maxFileBytes: MAX_FILE_BYTES,
    maxTotalBytes: MAX_INBOX_BYTES,
  };
  const after = await git.readFiles(head, paths, limits);
  const before = await git.readFiles(base, paths, limits);

  const files: InboxFile[] = [];
  const unread: Outcome[] = [];

  for (const path of paths) {
    const reason = unreadReason(path, after, before);

    if (reason) {
      unread.push({ path, applied: [], refused: [reason] });
      continue;
    }

    files.push({
      path,
      before: before.files.get(path) ?? null,
      after: after.files.get(path) ?? null,
    });
  }

  const reading = readInbox(files);
  const refusals = reading.refusals.map((refusal): Outcome => ({
    path: refusal.path,
    applied: [],
    refused: [refusal.reason],
  }));

  return [...unread, ...refusals, ...(await store.apply(reading, source))];
}

/** Why a file was not read, or null when it was. */
function unreadReason(
  path: string,
  after: FileReading,
  before: FileReading,
): string | null {
  if (after.tooLarge.has(path)) {
    return `larger than ${MAX_FILE_BYTES / 1024} KiB`;
  }

  if (before.tooLarge.has(path)) {
    return `the file in the snapshot is larger than ${MAX_FILE_BYTES / 1024} KiB, so it cannot be compared`;
  }

  if (after.overBudget.has(path) || before.overBudget.has(path)) {
    return `this hand-off holds more than ${MAX_INBOX_BYTES / 1024 / 1024} MiB of files in total. Send it in smaller parts`;
  }

  return null;
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
      handOff.commit
        ? `Inbox ${handOff.name}, commit ${handOff.commit.sha.slice(0, 12)} by ${handOff.commit.authorName} <${handOff.commit.authorEmail}>:`
        : `Inbox ${handOff.name}, object ${handOff.object.slice(0, 12)}:`,
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

import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git, gitBytes, type GitOptions } from 'modules/git/git-command';

/**
 * The git plumbing that the issue mirror needs, and nothing else.
 *
 * The repository is the bare mirror that the server keeps of a source. A
 * source can be somebody's working checkout, but the mirror is never that
 * checkout: this code reads and writes only the mirror. Commits come from a
 * scratch index in a temporary directory and land on refs outside
 * `refs/heads`, so a branch fetch and a read of code are exactly what they
 * were.
 *
 * Every command goes through `modules/git/git-command`, which turns off hooks
 * and `core.fsmonitor`. The content of the mirror came from a repository that
 * the server did not write, so no command here can run a filter or an
 * external diff.
 */

export interface GitIdentity {
  name: string;
  email: string;
}

export interface CommitInfo {
  sha: string;
  authorName: string;
  authorEmail: string;
  committerEmail: string;
}

/** What `readFiles` found, with the paths that it refused to read. */
export interface FileReading {
  files: Map<string, string | null>;
  /** Paths over the size limit for one file, with their sizes. */
  tooLarge: Map<string, number>;
  /** Paths left unread because the total limit was reached. */
  overBudget: Set<string>;
}

export interface TreeChange {
  status: 'A' | 'M' | 'D' | 'T';
  path: string;
}

export class GitRepository {
  private format: Promise<'sha1' | 'sha256'> | null = null;

  constructor(readonly path: string) {}

  /** One git command in the mirror, with its output and its exit code. */
  private async run(args: string[], options: GitOptions = {}) {
    return await gitBytes(args, { cwd: this.path, ...options });
  }

  /** One git command in the mirror, with its output as text. */
  private async text(args: string[], options: GitOptions = {}) {
    return await git(args, { cwd: this.path, ...options });
  }

  /** `sha1` for nearly every repository, and `sha256` for the rest. */
  async objectFormat(): Promise<'sha1' | 'sha256'> {
    this.format ??= this.text(['rev-parse', '--show-object-format'])
      .then((value) => (value.trim() === 'sha256' ? 'sha256' : 'sha1'))
      .catch(() => 'sha1' as const);

    return await this.format;
  }

  /** The commit a ref points at, or null when there is no such ref. */
  async resolve(ref: string): Promise<string | null> {
    const { stdout, code } = await this.run(
      ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      { okCodes: [1] },
    );

    return code === 0 ? stdout.toString().trim() : null;
  }

  /**
   * The object a ref points at, with no check of its type, or null when
   * there is no such ref.
   */
  async rawRef(ref: string): Promise<string | null> {
    const { stdout, code } = await this.run(
      ['rev-parse', '--verify', '--quiet', ref],
      { okCodes: [1] },
    );

    return code === 0 ? stdout.toString().trim() : null;
  }

  /** `commit`, `tree`, `blob` or `tag`, or null when the mirror lacks the object. */
  async objectType(sha: string): Promise<string | null> {
    try {
      return (await this.text(['cat-file', '-t', sha])).trim();
    } catch {
      return null;
    }
  }

  async refs(prefix: string): Promise<Array<{ ref: string; sha: string }>> {
    const output = await this.text([
      'for-each-ref',
      '--format=%(objectname) %(refname)',
      prefix,
    ]);

    return output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const space = line.indexOf(' ');
        return { sha: line.slice(0, space), ref: line.slice(space + 1) };
      });
  }

  async commit(sha: string): Promise<CommitInfo> {
    const output = await this.text([
      'log',
      '-1',
      '--no-show-signature',
      '--format=%H%x00%an%x00%ae%x00%ce',
      sha,
      '--',
    ]);
    const [full, authorName, authorEmail, committerEmail] = output
      .trim()
      .split('\0');

    return { sha: full, authorName, authorEmail, committerEmail };
  }

  /** Commits reachable along first parents, newest first. */
  async firstParents(sha: string, limit: number): Promise<CommitInfo[]> {
    const output = await this.text([
      'log',
      '--first-parent',
      `-n${limit}`,
      '--no-show-signature',
      '--format=%H%x00%an%x00%ae%x00%ce',
      sha,
      '--',
    ]);

    return output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [full, authorName, authorEmail, committerEmail] =
          line.split('\0');
        return { sha: full, authorName, authorEmail, committerEmail };
      });
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    const { stdout, code } = await this.run(['merge-base', a, b], {
      okCodes: [1],
    });

    return code === 0 ? stdout.toString().trim() : null;
  }

  /** Every file in a commit, by path, with its blob id. */
  async listTree(commit: string): Promise<Map<string, string>> {
    const output = await this.text([
      'ls-tree',
      '-r',
      '-z',
      '--full-tree',
      commit,
    ]);
    const files = new Map<string, string>();

    for (const record of output.split('\0')) {
      if (!record) {
        continue;
      }

      // `<mode> <type> <id>\t<path>`
      const tab = record.indexOf('\t');
      const [, type, id] = record.slice(0, tab).split(' ');

      if (type === 'blob') {
        files.set(record.slice(tab + 1), id);
      }
    }

    return files;
  }

  /** The files that differ between two commits. Renames are a delete and an add. */
  async diff(base: string, head: string): Promise<TreeChange[]> {
    const output = await this.text([
      'diff-tree',
      '-r',
      '-z',
      '--no-renames',
      '--no-ext-diff',
      '--name-status',
      base,
      head,
    ]);

    const fields = output.split('\0').filter(Boolean);
    const changes: TreeChange[] = [];

    for (let index = 0; index + 1 < fields.length; index += 2) {
      changes.push({
        status: fields[index] as TreeChange['status'],
        path: fields[index + 1],
      });
    }

    return changes;
  }

  /**
   * The content of `<commit>:<path>` for each path, or null where there is no
   * such file or the path is not a file.
   *
   * The sizes come first, from `cat-file --batch-check`, which prints one
   * short line for each path and never the content. A blob over
   * `maxFileBytes` is not read. A blob that would take the total over
   * `maxTotalBytes` is not read either. So the buffer that holds the content
   * has a known maximum, whatever an agent committed.
   *
   * The input of `cat-file` is one spec for each line, so a path with a
   * newline in it cannot be asked for, and comes back as null.
   */
  async readFiles(
    commit: string,
    paths: string[],
    limits: { maxFileBytes: number; maxTotalBytes: number },
  ): Promise<FileReading> {
    const files = new Map<string, string | null>();
    const tooLarge = new Map<string, number>();
    const overBudget = new Set<string>();
    const askable = paths.filter((path) => !path.includes('\n'));

    for (const path of paths) {
      files.set(path, null);
    }

    if (askable.length === 0) {
      return { files, tooLarge, overBudget };
    }

    const specs = (list: string[]) =>
      `${list.map((path) => `${commit}:${path}`).join('\n')}\n`;

    const sizes = (
      await this.text(['cat-file', '--batch-check'], { input: specs(askable) })
    )
      .split('\n')
      .filter(Boolean);

    const wanted: string[] = [];
    let total = 0;

    askable.forEach((path, index) => {
      // `<id> <type> <size>`. A missing path gives `<spec> missing`, which
      // does not match, and a spec can hold spaces, so the line is not split.
      const found = /^[0-9a-f]+ (\w+) (\d+)$/.exec(sizes[index] ?? '');

      if (found?.[1] !== 'blob') {
        return;
      }

      const length = Number(found[2]);

      if (length > limits.maxFileBytes) {
        tooLarge.set(path, length);
      } else if (total + length > limits.maxTotalBytes) {
        overBudget.add(path);
      } else {
        total += length;
        wanted.push(path);
      }
    });

    if (wanted.length === 0) {
      return { files, tooLarge, overBudget };
    }

    const { stdout } = await this.run(['cat-file', '--batch'], {
      input: specs(wanted),
      maxBuffer: total + wanted.length * 256,
    });

    let offset = 0;

    for (const path of wanted) {
      const newline = stdout.indexOf(0x0a, offset);
      const header = stdout.subarray(offset, newline).toString();
      offset = newline + 1;

      if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
        continue;
      }

      const length = Number(header.split(' ')[2]);
      // The content, then one newline that is not part of it.
      files.set(
        path,
        stdout.subarray(offset, offset + length).toString('utf8'),
      );
      offset += length + 1;
    }

    return { files, tooLarge, overBudget };
  }

  /**
   * A commit holding exactly `files`, or null when that is what `parent`
   * already holds and `allowEmpty` is false.
   *
   * Blob ids are computed here rather than asked of git, so a pass where
   * nothing changed costs one `ls-tree` and writes nothing. When something did
   * change, only the new blobs are written, and the tree is built in a scratch
   * index that is deleted afterwards; the checkout's own index is never
   * opened.
   */
  async writeSnapshot(parameters: {
    files: Map<string, string>;
    /**
     * The commit whose tree is the starting point, and the first parent of
     * the new commit.
     */
    parent: string | null;
    /**
     * More parents, after the first. The snapshot names each hand-off that it
     * applied here, so that the next hand-off of the same agent is compared
     * with the work of that agent and not with the first snapshot.
     */
    extraParents?: string[];
    /** Given the paths that differ from `parent`: added, changed or removed. */
    message: (changed: string[]) => string;
    identity: GitIdentity;
    allowEmpty?: boolean;
    date?: Date;
  }): Promise<string | null> {
    const format = await this.objectFormat();
    const existing = parameters.parent
      ? await this.listTree(parameters.parent)
      : new Map<string, string>();

    const wanted = [...parameters.files.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, content]) => {
        const bytes = Buffer.from(content, 'utf8');
        return { path, bytes, id: blobId(format, bytes) };
      });

    const changed = [
      ...wanted
        .filter((file) => existing.get(file.path) !== file.id)
        .map((file) => file.path),
      ...[...existing.keys()].filter((path) => !parameters.files.has(path)),
    ].sort();
    const unchanged = changed.length === 0;

    if (unchanged && !parameters.allowEmpty) {
      return null;
    }

    const scratch = await mkdtemp(join(tmpdir(), 'vantik-git-issues-'));

    try {
      let tree: string;

      if (unchanged && parameters.parent) {
        tree = (
          await this.text(['rev-parse', `${parameters.parent}^{tree}`])
        ).trim();
      } else {
        const known = new Set(existing.values());
        const missing = wanted.filter((file) => !known.has(file.id));

        await this.writeBlobs(scratch, missing);

        const index = join(scratch, 'index');
        const records = wanted
          .map((file) => `100644 ${file.id}\t${file.path}\0`)
          .join('');

        await this.run(['update-index', '--add', '-z', '--index-info'], {
          input: records,
          env: { GIT_INDEX_FILE: index },
        });

        tree = (
          await this.text(['write-tree'], { env: { GIT_INDEX_FILE: index } })
        ).trim();
      }

      const when = `${Math.floor((parameters.date ?? new Date()).getTime() / 1000)} +0000`;
      // `--no-gpg-sign` because `commit.gpgsign` in a global configuration
      // would make `commit-tree` ask for a key that the server does not have.
      const args = ['commit-tree', '--no-gpg-sign', tree, '-F', '-'];
      const parents = [
        ...new Set([
          ...(parameters.parent ? [parameters.parent] : []),
          ...(parameters.extraParents ?? []),
        ]),
      ];

      for (const parent of parents) {
        args.push('-p', parent);
      }

      return (
        await this.text(args, {
          input: parameters.message(changed),
          env: {
            GIT_AUTHOR_NAME: parameters.identity.name,
            GIT_AUTHOR_EMAIL: parameters.identity.email,
            GIT_AUTHOR_DATE: when,
            GIT_COMMITTER_NAME: parameters.identity.name,
            GIT_COMMITTER_EMAIL: parameters.identity.email,
            GIT_COMMITTER_DATE: when,
          },
        })
      ).trim();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  /**
   * Blobs go through files and one `hash-object --stdin-paths`, because a
   * process per blob is a thousand processes on the first pass of a team with
   * a thousand issues. `--no-filters` keeps a clean filter from the checkout's
   * attributes out of it: the content is stored as it is given.
   */
  private async writeBlobs(
    scratch: string,
    blobs: Array<{ bytes: Buffer; id: string }>,
  ) {
    if (blobs.length === 0) {
      return;
    }

    const paths = await Promise.all(
      blobs.map(async (blob, index) => {
        const path = join(scratch, `blob-${index}`);
        await writeFile(path, blob.bytes);
        return path;
      }),
    );

    const written = (
      await this.text(['hash-object', '-w', '--no-filters', '--stdin-paths'], {
        input: `${paths.join('\n')}\n`,
      })
    )
      .split('\n')
      .filter(Boolean);

    blobs.forEach((blob, index) => {
      if (written[index] !== blob.id) {
        throw new Error(
          `git stored a blob as ${written[index]} where ${blob.id} was expected`,
        );
      }
    });
  }

  /**
   * Moves `ref` to `sha` only if it is still at `expected`, where null means
   * that it must not exist yet. False when somebody else moved it first.
   */
  async updateRef(
    ref: string,
    sha: string,
    expected: string | null,
  ): Promise<boolean> {
    const { code } = await this.run(
      ['update-ref', '-m', 'vantik: issue mirror', ref, sha, expected ?? ''],
      { okCodes: [1, 128] },
    );

    return code === 0;
  }

  /** Deletes `ref` only if it is still at `expected`. */
  async deleteRef(ref: string, expected: string): Promise<boolean> {
    const { code } = await this.run(['update-ref', '-d', ref, expected], {
      okCodes: [1, 128],
    });

    return code === 0;
  }
}

/** The id git gives a blob: a hash of a short header and the bytes. */
export function blobId(format: 'sha1' | 'sha256', bytes: Buffer): string {
  return createHash(format)
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
}

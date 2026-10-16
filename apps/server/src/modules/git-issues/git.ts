import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The git plumbing the issue mirror needs, and nothing else.
 *
 * The repository is somebody's working checkout. Everything here is chosen so
 * that the mirror can live inside it without that person ever noticing: no
 * command reads or writes `HEAD`, the index or the working tree. Commits are
 * built from a scratch index in a temporary directory and land on one ref
 * outside `refs/heads`, so `git status`, `git branch` and every checkout are
 * exactly what they were.
 *
 * It is also a repository the server did not write, running as the server's
 * account. Hooks are switched off on every call, because a hook in that
 * checkout is code the server would otherwise execute, and nothing that runs a
 * filter or an external diff is used at all.
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

export interface TreeChange {
  status: 'A' | 'M' | 'D' | 'T';
  path: string;
}

class GitCommandError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args[0]} exited with ${code}: ${stderr.trim()}`);
  }
}

// Variables a parent git process sets for its children. A server started from
// a hook, or a test run from one, would otherwise aim every command here at
// that other repository.
const INHERITED_GIT_VARIABLES = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
];

export class GitRepository {
  private format: Promise<'sha1' | 'sha256'> | null = null;

  constructor(readonly path: string) {}

  /**
   * One git command, with its output as bytes.
   *
   * `safe.directory` names this one path. An admin registered it, and the
   * server's account is often not the account that owns the checkout, which
   * git would otherwise refuse to open. It is safe to allow here because the
   * two things that make a foreign repository dangerous, hooks and an fsmonitor
   * command, are off for every call.
   */
  async run(
    args: string[],
    options: {
      input?: string | Buffer;
      env?: Record<string, string>;
      okCodes?: number[];
    } = {},
  ): Promise<{ stdout: Buffer; code: number }> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      ...options.env,
    };

    for (const name of INHERITED_GIT_VARIABLES) {
      if (!options.env?.[name]) {
        delete env[name];
      }
    }

    const fullArgs = [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      `safe.directory=${this.path}`,
      '-C',
      this.path,
      ...args,
    ];

    return await new Promise((resolve, reject) => {
      const child = spawn('git', fullArgs, { env });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0 || options.okCodes?.includes(code ?? -1)) {
          resolve({ stdout: Buffer.concat(stdout), code: code ?? 0 });
          return;
        }

        reject(
          new GitCommandError(args, code, Buffer.concat(stderr).toString()),
        );
      });

      child.stdin.on('error', () => {
        // A command that exits before reading all of its input closes the
        // pipe. The exit code reports what went wrong, and this would only
        // report it a second time as an unhandled error.
      });
      child.stdin.end(options.input ?? '');
    });
  }

  private async text(
    args: string[],
    options?: Parameters<GitRepository['run']>[1],
  ) {
    return (await this.run(args, options)).stdout.toString('utf8');
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
   * The content of `<commit>:<path>` for each spec, or null where there is no
   * such file.
   *
   * One `cat-file --batch` for the lot. Its input is one spec per line, so a
   * path with a newline in it cannot be asked for, and comes back as null.
   */
  async readFiles(
    commit: string,
    paths: string[],
  ): Promise<Map<string, string | null>> {
    const result = new Map<string, string | null>();
    const askable = paths.filter((path) => !path.includes('\n'));

    for (const path of paths) {
      result.set(path, null);
    }

    if (askable.length === 0) {
      return result;
    }

    const { stdout } = await this.run(['cat-file', '--batch'], {
      input: `${askable.map((path) => `${commit}:${path}`).join('\n')}\n`,
    });

    let offset = 0;

    for (const path of askable) {
      const newline = stdout.indexOf(0x0a, offset);
      const header = stdout.subarray(offset, newline).toString();
      offset = newline + 1;

      if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
        continue;
      }

      const [, type, size] = header.split(' ');
      const length = Number(size);
      const content = stdout.subarray(offset, offset + length);
      // The content, then one newline that is not part of it.
      offset += length + 1;

      if (type === 'blob') {
        result.set(path, content.toString('utf8'));
      }
    }

    return result;
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
    parent: string | null;
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
      const args = ['commit-tree', tree, '-F', '-'];

      if (parameters.parent) {
        args.push('-p', parameters.parent);
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

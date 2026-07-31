import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { RunnerError } from './failures';
import { branchName, git, headCommit, isRepo } from './git';

const exec = promisify(execFile);

export interface PreparedWorkspace {
  /** Where the harness works. Never the user's own checkout. */
  workdir: string;
  /** Recorded before anything is edited; the patch is computed against it. */
  baseCommit: string;
  branch: string;
  /** Removes the scratch directory. Safe to call twice. */
  cleanup: () => Promise<void>;
}

export interface PrepareOptions {
  /** The user's repository. Cloned from, never worked in directly. */
  repoPath?: string;
  /** A remote to clone instead, when there is no local checkout. */
  repoUrl?: string;
  baseBranch?: string;
  branchPrefix?: string;
  issueKey: string;
  issueTitle: string;
  setupCommands?: string[];
  onEvent?: (message: string) => void;
}

/**
 * An isolated checkout for one run.
 *
 * Never the user's working copy. An agent running `git checkout` in the
 * directory someone is working in is a way to lose uncommitted work, and it is
 * not a hypothetical — the harness has a shell and full write access by
 * design.
 *
 * A local clone with `--shared` where possible: it copies no object data, so
 * preparing a run against a large repository costs a directory of refs rather
 * than a gigabyte, and the objects the agent creates stay in the scratch
 * clone until they are deliberately pushed back.
 */
export async function prepareWorkspace(
  options: PrepareOptions,
): Promise<PreparedWorkspace> {
  const scratch = await mkdtemp(join(tmpdir(), 'vantik-run-'));
  const workdir = join(scratch, 'repo');

  const cleanup = async () => {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    if (options.repoPath) {
      const source = resolve(options.repoPath);

      if (!(await isRepo(source))) {
        throw new RunnerError(
          'ENVIRONMENT_SETUP_FAILED',
          `${source} is not a git repository.`,
        );
      }

      options.onEvent?.(`Cloning ${source}`);
      // --shared avoids copying objects; --no-hardlinks keeps the scratch
      // clone from writing into the source's object store.
      await git(scratch, [
        'clone',
        '--shared',
        '--no-hardlinks',
        '--quiet',
        source,
        workdir,
      ]);
    } else if (options.repoUrl) {
      options.onEvent?.(`Cloning ${options.repoUrl}`);
      await git(scratch, ['clone', '--quiet', options.repoUrl, workdir]);
    } else {
      throw new RunnerError(
        'ENVIRONMENT_SETUP_FAILED',
        'This run has neither a repo path nor a repo url configured. Set one on the workspace or pass --repo.',
      );
    }

    if (options.baseBranch) {
      await git(workdir, ['checkout', '--quiet', options.baseBranch]);
    }

    const baseCommit = await headCommit(workdir);
    const branch = branchName(
      options.branchPrefix ?? 'agent',
      options.issueKey,
      options.issueTitle,
    );

    await git(workdir, ['checkout', '--quiet', '-b', branch]);

    await runSetup(workdir, options.setupCommands ?? [], options.onEvent);

    return { workdir, baseCommit, branch, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * The setup phase.
 *
 * Separate from verification because the hosted executor runs the two in
 * different phases with different credentials and different egress — setup
 * needs the network and install-time secrets, the agent phase should have
 * neither. Keeping them apart here means that split costs nothing later.
 */
async function runSetup(
  workdir: string,
  commands: string[],
  onEvent?: (message: string) => void,
): Promise<void> {
  for (const command of commands) {
    onEvent?.(`Setup: ${command}`);

    try {
      await exec(command, {
        cwd: workdir,
        shell: true,
        maxBuffer: 32 * 1024 * 1024,
        timeout: 15 * 60 * 1000,
      });
    } catch (error) {
      const stderr = String((error as { stderr?: string })?.stderr ?? '').slice(
        -2000,
      );
      throw new RunnerError(
        'ENVIRONMENT_SETUP_FAILED',
        `Setup command failed: ${command}\n${stderr}`,
        error,
      );
    }
  }
}

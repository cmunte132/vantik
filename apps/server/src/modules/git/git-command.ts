import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** How long one git command may take before it is killed. */
export const GIT_TIMEOUT_MS = 5 * 60 * 1000;

/** The largest output one git command may return. */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * How git reaches one remote: its address, and the credential as environment.
 *
 * The credential never goes in argv or in the URL. Both are readable by any
 * process on the host (`ps`, `/proc/<pid>/cmdline`) and both end up in error
 * messages, which is how a token reaches a log. Git reads `GIT_CONFIG_*` and
 * `GIT_SSH_COMMAND` from the environment of its own process only.
 */
export interface GitRemote {
  /** A URL or an absolute path. */
  url: string;
  /** Extra environment for every git command that talks to this remote. */
  env: Record<string, string>;
  /** Removes anything written to disk for the credential, such as a key file. */
  dispose(): Promise<void>;
  /** Values that must be scrubbed from any error text before it is shown. */
  secrets: string[];
}

/** A remote that needs no credential: a path, or a public URL. */
export function anonymousRemote(url: string): GitRemote {
  return { url, env: {}, dispose: async () => undefined, secrets: [] };
}

/**
 * An HTTPS remote that authenticates with a token.
 *
 * Sent as a Basic `Authorization` header through `http.extraHeader`, which
 * GitHub, Forgejo, Gitea and GitLab all accept with any user name.
 */
export function tokenRemote(
  url: string,
  token: string,
  username = 'x-access-token',
  options: { followRedirects?: boolean } = {},
): GitRemote {
  const basic = Buffer.from(`${username}:${token}`).toString('base64');

  return {
    url,
    // Git sends `http.extraHeader` to every address that it requests. If the
    // caller turns redirects off, a redirect to a different host cannot get
    // the token.
    env: configEnv({
      'http.extraHeader': `Authorization: Basic ${basic}`,
      ...(options.followRedirects === false
        ? { 'http.followRedirects': 'false' }
        : {}),
    }),
    dispose: async () => undefined,
    secrets: [token, basic],
  };
}

/**
 * An SSH remote that authenticates with a private key.
 *
 * The key is written to a private temporary file for the life of the remote,
 * because ssh reads a key only from a file or an agent. Host keys are pinned
 * on first use into `knownHostsFile`, so a later change of host key is refused
 * rather than trusted.
 */
export async function sshKeyRemote(
  url: string,
  privateKey: string,
  knownHostsFile: string,
): Promise<GitRemote> {
  const directory = await mkdtemp(join(tmpdir(), 'vantik-ssh-'));
  const keyFile = join(directory, 'key');

  await writeFile(
    keyFile,
    privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`,
  );
  await chmod(keyFile, 0o600);

  return {
    url,
    env: {
      GIT_SSH_COMMAND: [
        'ssh',
        '-i',
        shellQuote(keyFile),
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        `UserKnownHostsFile=${shellQuote(knownHostsFile)}`,
      ].join(' '),
    },
    dispose: () => rm(directory, { recursive: true, force: true }),
    secrets: [privateKey],
  };
}

/**
 * Git configuration passed through the environment.
 *
 * `GIT_CONFIG_COUNT` is read as command-line configuration, which is the only
 * kind git trusts for `safe.directory`. That setting has to be here: the server
 * runs as its own user and reads repositories other users own, and git refuses
 * those otherwise.
 */
export function configEnv(
  entries: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  const pairs = Object.entries(entries);

  env.GIT_CONFIG_COUNT = String(pairs.length);

  pairs.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });

  return env;
}

/** Merges two sets of `GIT_CONFIG_*` entries into one. */
function mergeConfigEnv(
  base: Record<string, string>,
  extra: Record<string, string>,
): Record<string, string> {
  const entries: Record<string, string> = {};

  for (const env of [base, extra]) {
    const count = Number(env.GIT_CONFIG_COUNT ?? 0);

    for (let index = 0; index < count; index += 1) {
      entries[env[`GIT_CONFIG_KEY_${index}`]] =
        env[`GIT_CONFIG_VALUE_${index}`];
    }
  }

  return configEnv(entries);
}

export interface GitOptions {
  cwd?: string;
  remote?: GitRemote;
  timeoutMs?: number;
  /** The largest output accepted, in bytes. More fails the command. */
  maxBuffer?: number;
  /** Bytes for the standard input of the command. */
  input?: string | Buffer;
  /** Extra environment, for example `GIT_INDEX_FILE`. It wins over the rest. */
  env?: Record<string, string>;
  /** Exit codes that are an answer and not a failure. */
  okCodes?: number[];
}

/**
 * Variables that a parent git process sets for its children. A server that a
 * hook started would otherwise aim every command at the repository of that
 * hook.
 */
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

/**
 * Runs one git command and returns its standard output.
 *
 * Nothing here reads the caller's global git configuration for credentials,
 * and nothing waits on a prompt: a command that would ask for a password fails
 * at once instead of hanging a request.
 *
 * Hooks and `core.fsmonitor` are off for every command. A repository on this
 * server can be one that another person owns, and a hook or an fsmonitor
 * command in it is code that the server would run as itself.
 */
export async function git(
  args: string[],
  options: GitOptions = {},
): Promise<string> {
  const { stdout } = await run(args, options, 'utf8');

  return stdout;
}

/** As `git`, with the output as bytes and the exit code that was accepted. */
export async function gitBytes(
  args: string[],
  options: GitOptions = {},
): Promise<{ stdout: Buffer; code: number }> {
  return await run(args, options, 'buffer');
}

async function run<E extends 'utf8' | 'buffer'>(
  args: string[],
  options: GitOptions,
  encoding: E,
): Promise<{ stdout: E extends 'buffer' ? Buffer : string; code: number }> {
  const remoteEnv = { ...options.remote?.env, ...options.env };
  const baseConfig = configEnv({
    'safe.directory': '*',
    'credential.helper': '',
    'core.askPass': '',
    'core.hooksPath': '/dev/null',
    'core.fsmonitor': 'false',
  });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_ASKPASS: 'true',
    SSH_ASKPASS: 'true',
    ...remoteEnv,
    ...mergeConfigEnv(baseConfig, remoteEnv),
  };

  for (const name of INHERITED_GIT_VARIABLES) {
    if (!remoteEnv[name]) {
      delete env[name];
    }
  }

  const child = exec('git', args, {
    cwd: options.cwd,
    env,
    maxBuffer: options.maxBuffer ?? MAX_BUFFER,
    timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
    encoding,
  });

  if (options.input !== undefined) {
    // A command that exits before it reads all of its input closes the pipe.
    // The exit code reports the fault, so this error would only repeat it.
    child.child.stdin?.on('error', () => undefined);
    child.child.stdin?.end(options.input);
  }

  try {
    const { stdout } = await child;

    return { stdout: stdout as never, code: 0 };
  } catch (error) {
    const code = (error as { code?: unknown }).code;

    if (typeof code === 'number' && options.okCodes?.includes(code)) {
      return {
        stdout: (error as { stdout: unknown }).stdout as never,
        code,
      };
    }

    throw new GitCommandError(args, error, options.remote?.secrets ?? []);
  }
}

/**
 * Arguments that stop the other end of a local transport from a run of its
 * hooks and from a run of the commands in its config.
 *
 * Git removes `GIT_CONFIG_*` from the environment of a local `upload-pack` or
 * `receive-pack`, so the base configuration above does not reach it. A
 * checkout with a `pre-receive`, `post-receive` or `reference-transaction`
 * hook would then run that hook as the server. So would
 * `core.alternateRefsCommand` of its config, which git runs through the shell
 * when `objects/info/alternates` exists, and `gc.recentObjectsHook`, which a
 * `gc --auto` after a push can run. The command line of the helper is the one
 * place that can carry the settings. A remote that is not a local
 * path needs nothing, and gets no arguments.
 */
export function localTransportArgs(
  url: string,
  command: 'upload-pack' | 'receive-pack',
): string[] {
  if (!url.startsWith('/') && !url.startsWith('file://')) {
    return [];
  }

  const helper = [
    'git',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    "'safe.directory=*'",
    // The helper reads the source's own config. These stop that config from
    // running a command through the shell, or through a gc after a push.
    '-c',
    'core.alternateRefsCommand=true',
    '-c',
    'receive.autogc=false',
    '-c',
    'gc.auto=0',
    '-c',
    'maintenance.auto=false',
    command,
  ].join(' ');

  return [`--${command}=${helper}`];
}

/** A failed git command, with any credential removed from its message. */
export class GitCommandError extends Error {
  readonly stderr: string;
  readonly code: string | number | undefined;
  /** True when the command ran past its timeout and was killed. */
  readonly killed: boolean;

  constructor(args: string[], cause: unknown, secrets: string[]) {
    const failure = cause as {
      stderr?: string;
      message?: string;
      code?: string | number;
      killed?: boolean;
    };
    const stderr = scrub(String(failure?.stderr ?? '').trim(), secrets);
    const command = scrub(`git ${args.join(' ')}`, secrets);

    super(
      failure?.code === 'ENOENT'
        ? 'git is not installed on this server.'
        : failure?.killed
          ? `${command} took too long and was stopped.`
          : /maxBuffer/i.test(String(failure?.message))
            ? `${command} gave more output than the limit (maxBuffer).`
            : `${command} failed${stderr ? `: ${stderr}` : ''}`,
    );

    this.stderr = stderr;
    this.code = failure?.code;
    this.killed = Boolean(failure?.killed);
  }
}

/** Replaces every secret in `text` with a marker. */
export function scrub(text: string, secrets: string[]): string {
  return secrets
    .filter((secret) => secret && secret.length >= 4)
    .reduce(
      (current, secret) => current.split(secret).join('[redacted]'),
      text,
    );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type CredentialsService } from 'modules/agent-runs/credentials/credentials.service';
import { type SourceRepo } from 'modules/git/git-source';
import { GitRemoteSource } from 'modules/git/sources/git-remote.source';

import { GitRepository } from './git';
import { gitIssueRemote, HostRefusedPushError } from './issue-remote';
import { INBOX_PREFIX, SNAPSHOT_REF, syncRepository } from './sync';

/**
 * The remote tier, with a real git host: `git http-backend` behind a small
 * HTTP server on the loopback address. The pass reaches it through the code of
 * `GitRemoteSource`, so the address check, the token header and the fetch and
 * push remotes are the ones that a Forgejo connection uses.
 */

// The guard resolves host names, and this host is the loopback address.
jest.mock('modules/git/sources/host-address-guard', () => ({
  ...jest.requireActual('modules/git/sources/host-address-guard'),
  assertHostAllowed: jest.fn().mockResolvedValue(undefined),
}));

jest.setTimeout(60_000);

const TOKEN = 'secret-token-1234';

let root: string;
let server: Server;
let base: string;
let authorizations: string[];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  }).trim();
}

/** Serves each bare repository under `projectRoot` over the smart HTTP protocol. */
function serve(projectRoot: string): Promise<Server> {
  const instance = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');

    authorizations.push(request.headers.authorization ?? '');

    const backend = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: projectRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: request.method ?? 'GET',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: request.headers['content-type'] ?? '',
        HTTP_CONTENT_ENCODING: request.headers['content-encoding'] ?? '',
        REMOTE_USER: 'bot',
        REMOTE_ADDR: '127.0.0.1',
      },
    });

    request.pipe(backend.stdin);

    // The CGI answer is headers, a blank line, then the body.
    let buffered = Buffer.alloc(0);
    let headersSent = false;

    backend.stdout.on('data', (chunk: Buffer) => {
      if (headersSent) {
        response.write(chunk);
        return;
      }

      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');

      if (end === -1) {
        return;
      }

      const head = buffered.subarray(0, end).toString('utf8').split('\r\n');
      const headers: Record<string, string> = {};
      let status = 200;

      for (const line of head) {
        const [name, ...value] = line.split(': ');

        if (name.toLowerCase() === 'status') {
          status = Number.parseInt(value.join(': '), 10);
        } else {
          headers[name] = value.join(': ');
        }
      }

      response.writeHead(status, headers);
      response.write(buffered.subarray(end + 4));
      headersSent = true;
    });
    backend.stdout.on('end', () => response.end());
  });

  return new Promise((resolve) =>
    instance.listen(0, '127.0.0.1', () => resolve(instance)),
  );
}

function remoteRepo(): SourceRepo {
  return {
    workspaceId: 'workspace-1',
    integrationAccountId: 'account-1',
    accountId: base,
    externalRepoId: '7',
    fullName: 'owner/project',
    listing: {
      id: '7',
      fullName: 'owner/project',
      cloneUrl: `${base}/owner/project.git`,
    },
    config: { kind: 'forgejo', baseUrl: base, username: 'bot' },
  };
}

async function pass(mirror: string) {
  const source = new GitRemoteSource({
    revealRemoteToken: jest.fn().mockResolvedValue(TOKEN),
  } as unknown as CredentialsService);
  const fetch = await source.fetchRemote(remoteRepo());
  const push = await source.pushRemote(remoteRepo());

  try {
    return await syncRepository(
      new GitRepository(mirror),
      gitIssueRemote(mirror, { fetch, push }, (work) => work()),
      {
        load: async () => ({ teams: [], labels: [], issues: [] }),
        apply: async () => [],
      },
    );
  } finally {
    await Promise.all([fetch.dispose(), push.dispose()]);
  }
}

describe('the issue mirror of a repository on a git host', () => {
  let hostRepository: string;
  let mirror: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vantik-git-remote-tier-'));
    authorizations = [];
    hostRepository = join(root, 'host', 'owner', 'project.git');
    mirror = join(root, 'mirror.git');

    git(root, 'init', '-q', '--bare', '-b', 'main', hostRepository);
    git(hostRepository, 'config', 'http.receivepack', 'true');
    git(root, 'init', '-q', '--bare', mirror);

    // The host needs one commit, which a person pushed.
    const work = join(root, 'work');
    git(root, 'init', '-q', '-b', 'main', work);
    git(work, 'commit', '-q', '--allow-empty', '-m', 'code');
    git(work, 'push', '-q', hostRepository, 'main');

    server = await serve(join(root, 'host'));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  it('writes the snapshot to the host, with the token of the connection', async () => {
    const result = await pass(mirror);

    expect(result.wrote).toBe(true);
    expect(git(hostRepository, 'rev-parse', SNAPSHOT_REF)).toBe(result.tip);
    expect(authorizations.length).toBeGreaterThan(0);
    expect(
      authorizations.every(
        (header) =>
          header === `Basic ${Buffer.from(`bot:${TOKEN}`).toString('base64')}`,
      ),
    ).toBe(true);
  });

  it('reads an inbox ref from the host, and deletes it there after the push', async () => {
    const first = await pass(mirror);
    const tip = first.tip as string;

    // An agent pushes a hand-off to the host: one commit on the snapshot.
    const agent = join(root, 'agent');
    git(root, 'clone', '-q', '--no-checkout', hostRepository, agent);
    git(agent, 'fetch', '-q', 'origin', `+${SNAPSHOT_REF}:${SNAPSHOT_REF}`);
    git(agent, 'checkout', '-q', '--detach', SNAPSHOT_REF);
    git(agent, 'commit', '-q', '--allow-empty', '-m', 'hand-off');
    git(agent, 'push', '-q', 'origin', `HEAD:${INBOX_PREFIX}agent-1`);

    const second = await pass(mirror);

    expect(second.handOffs.map((handOff) => handOff.name)).toEqual(['agent-1']);
    expect(second.tip).not.toBe(tip);
    expect(git(hostRepository, 'for-each-ref', INBOX_PREFIX)).toBe('');
  });

  it('reports a host that refuses refs/vantik, and leaves the mirror as it was', async () => {
    git(hostRepository, 'config', 'receive.hideRefs', 'refs/vantik');

    const refused = pass(mirror);

    await expect(refused).rejects.toBeInstanceOf(HostRefusedPushError);
    await expect(refused).rejects.toThrow(/refs\/vantik\/issues/);
    // The mirror must not claim a snapshot that the host does not have.
    expect(git(mirror, 'for-each-ref', 'refs/vantik')).toBe('');
    expect(authorizations.join()).not.toContain(TOKEN);
  });
});

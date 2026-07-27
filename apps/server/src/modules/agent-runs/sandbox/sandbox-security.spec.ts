/**
 * The security properties of the hosted executor.
 *
 * These are the tests worth having. The rest of the executor is plumbing that
 * fails loudly; these cover the things that fail *silently* — a token reaching
 * a guest, a key surviving into an event row a human reads, a sandbox that
 * quietly downgraded to something weaker than it claims.
 */
import { PrismaService } from 'nestjs-prisma';

import { CredentialsService } from '../credentials/credentials.service';
import { egressAllowlistForTest } from '../executors/hosted.executor';
import { GondolinRuntime } from './gondolin.runtime';
import { scrubSecrets } from './scrub';

const WORKSPACE = 'workspace-1';

// The jest environment has no server secret; the store refuses to encrypt
// without one, which is itself the correct behaviour.
beforeAll(() => {
  process.env.CREDENTIAL_ENCRYPTION_KEY ??= 'test-encryption-key';
});

function buildCredentials() {
  const rows: Array<Record<string, unknown>> = [];

  const prisma = {
    workspaceCredential: {
      findFirst: jest.fn(({ where, select }) => {
        const row = rows.find(
          (candidate) =>
            candidate.workspaceId === where.workspaceId &&
            candidate.kind === where.kind &&
            candidate.deleted == null,
        );
        if (!row) {
          return Promise.resolve(null);
        }
        // Mirrors Prisma: a `select` returns only what it named.
        return Promise.resolve(
          select
            ? Object.fromEntries(
                Object.keys(select).map((key) => [key, row[key]]),
              )
            : row,
        );
      }),
      findMany: jest.fn(({ select }) =>
        Promise.resolve(
          rows.map((row) =>
            Object.fromEntries(
              Object.keys(select ?? row).map((key) => [key, row[key]]),
            ),
          ),
        ),
      ),
      create: jest.fn(({ data, select }) => {
        const row = { ...data, updatedAt: new Date() };
        rows.push(row);
        return Promise.resolve(
          Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])),
        );
      }),
      update: jest.fn(({ data, select }) => {
        Object.assign(rows[0], data);
        return Promise.resolve(
          Object.fromEntries(
            Object.keys(select).map((key) => [key, rows[0][key]]),
          ),
        );
      }),
      updateMany: jest.fn(({ data }) => {
        rows.forEach((row) => Object.assign(row, data));
        return Promise.resolve({ count: rows.length });
      }),
    },
  } as unknown as PrismaService;

  return { service: new CredentialsService(prisma), rows };
}

describe('workspace credential store', () => {
  const PLANTED = 'ghp_plantedTokenValue1234567890abcd';

  it('never returns the secret, only a masked handle', async () => {
    const { service } = buildCredentials();

    const handle = await service.put({
      workspaceId: WORKSPACE,
      kind: 'GIT_TOKEN',
      secret: PLANTED,
    });

    const serialised = JSON.stringify(handle);
    expect(serialised).not.toContain(PLANTED);
    expect(handle.hint).toBe('…abcd');
  });

  it('does not leak the secret through the listing either', async () => {
    const { service } = buildCredentials();

    await service.put({
      workspaceId: WORKSPACE,
      kind: 'MODEL_API_KEY',
      secret: PLANTED,
    });

    const listed = await service.list(WORKSPACE);

    // The listing is the endpoint most likely to grow a field by accident.
    expect(JSON.stringify(listed)).not.toContain(PLANTED);
    expect(Object.keys(listed[0] ?? {})).toEqual(
      expect.not.arrayContaining(['ciphertext', 'nonce', 'tag']),
    );
  });

  it('stores ciphertext, not the secret', async () => {
    const { service, rows } = buildCredentials();

    await service.put({
      workspaceId: WORKSPACE,
      kind: 'GIT_TOKEN',
      secret: PLANTED,
    });

    expect(rows[0].ciphertext).not.toContain(PLANTED);
    expect(String(rows[0].ciphertext)).toMatch(/^[0-9a-f]+$/);
  });

  it('round-trips the secret for the executor', async () => {
    const { service } = buildCredentials();

    await service.put({
      workspaceId: WORKSPACE,
      kind: 'GIT_TOKEN',
      secret: PLANTED,
    });

    await expect(service.reveal(WORKSPACE, 'GIT_TOKEN')).resolves.toMatchObject(
      { secret: PLANTED },
    );
  });

  it('gives away nothing when a secret is too short to hint at', async () => {
    const { service } = buildCredentials();

    const handle = await service.put({
      workspaceId: WORKSPACE,
      kind: 'GIT_TOKEN',
      secret: 'short',
    });

    // Four characters of a five-character secret is not a hint.
    expect(handle.hint).toBe('…');
  });
});

describe('secret scrubbing', () => {
  const KEY = 'sk-plantedModelKey0987654321';

  it('removes a planted key from captured output', () => {
    const captured = `installing…\nusing ${KEY} for auth\ndone`;

    expect(scrubSecrets(captured, [KEY])).not.toContain(KEY);
    expect(scrubSecrets(captured, [KEY])).toContain('[redacted]');
  });

  it('catches a key that was url-encoded on the way out', () => {
    const encoded = encodeURIComponent(KEY);
    const captured = `GET /v1?key=${encoded}`;

    expect(scrubSecrets(captured, [KEY])).not.toContain(encoded);
  });

  it('masks a credential in a remote url even when it is not a known secret', () => {
    const captured =
      'fatal: unable to access https://x-access-token:ghp_someOtherToken@github.com/acme/app.git';

    const scrubbed = scrubSecrets(captured, []);

    expect(scrubbed).not.toContain('ghp_someOtherToken');
    expect(scrubbed).toContain('[redacted]@');
  });

  it('masks the longer secret whole when one contains another', () => {
    const short = 'abcdefgh';
    const long = `${short}ijklmnop`;

    // Scrubbing shortest-first would shred the long one into fragments that
    // still reveal its shape.
    const scrubbed = scrubSecrets(`token=${long}`, [short, long]);

    expect(scrubbed).toBe('token=[redacted]');
  });

  it('ignores values too short to be a secret', () => {
    // A three-character "secret" would otherwise redact half of every log.
    expect(scrubSecrets('the cat sat', ['cat'])).toBe('the cat sat');
  });
});

describe('egress policy', () => {
  it('does not allow the guest to reach a git host', () => {
    const allow = egressAllowlistForTest('https://openrouter.ai/api/v1');

    // The guest never pushes — the host does, on its behalf. So it has no
    // reason to reach a git host, and an attempt is a signal not a need.
    expect(allow).not.toContain('github.com');
    expect(allow.some((host) => host.includes('github'))).toBe(false);
  });

  it('allows the model endpoint the workspace configured', () => {
    expect(egressAllowlistForTest('https://openrouter.ai/api/v1')).toContain(
      'openrouter.ai',
    );
  });

  it('allows a package registry, because setup has to be able to install', () => {
    expect(egressAllowlistForTest(null)).toContain('registry.npmjs.org');
  });
});

describe('the git token never enters the guest', () => {
  const GIT_TOKEN = 'ghp_gitTokenThatMustNeverEnterTheGuest';
  const MODEL_KEY = 'sk-modelKeyTheHarnessGenuinelyNeeds';

  /**
   * Drives the executor far enough to capture the sandbox spec it builds, and
   * asserts the git token is nowhere in it.
   *
   * This is the property the whole hosted design turns on. A sandbox stops an
   * agent rooting the host; only keeping the credential outside the guest
   * stops a prompt-injected agent exfiltrating it. If this test ever fails,
   * the sandbox is doing much less than it appears to.
   */
  async function captureSandboxSpec() {
    const { HostedExecutor } = await import('../executors/hosted.executor');

    let captured:
      | {
          env: Record<string, string>;
          files: Record<string, string>;
          secrets: Record<string, { value: string; hosts: string[] }>;
        }
      | undefined;

    const runtime = {
      availability: async () => ({ available: true, tier: 'microvm' as const }),
      create: async (spec: {
        env: Record<string, string>;
        files: Record<string, string>;
        secrets: Record<string, { value: string; hosts: string[] }>;
      }) => {
        captured = spec;
        // Stop the run here: the spec is the artefact under test.
        throw new Error('halt after spec');
      },
    };

    const credentials = {
      has: async (): Promise<boolean> => true,
      reveal: async (_workspace: string, kind: string) =>
        kind === 'GIT_TOKEN'
          ? { secret: GIT_TOKEN, baseUrl: null }
          : { secret: MODEL_KEY, baseUrl: 'https://openrouter.ai/api/v1' },
    };

    const agentRuns = {
      transition: async (): Promise<undefined> => undefined,
      appendEvent: async (): Promise<undefined> => undefined,
    };

    const executor = new HostedExecutor(
      { register: (): undefined => undefined } as never,
      runtime as never,
      credentials as never,
      {} as never,
      agentRuns as never,
      { agentRun: { findMany: async (): Promise<unknown[]> => [] } } as never,
    );

    await (
      executor as unknown as { execute: (run: unknown) => Promise<void> }
    ).execute({
      id: 'run-1',
      workspaceId: WORKSPACE,
      issueId: 'issue-1',
      config: { repoUrl: 'https://github.com/acme/app.git' },
      contextPack: { issue: { key: 'ENG-1', title: 'Thing' } },
    });

    return captured;
  }

  it('is absent from the guest environment', async () => {
    const spec = await captureSandboxSpec();

    expect(spec).toBeDefined();
    expect(JSON.stringify(spec?.env)).not.toContain(GIT_TOKEN);
    // Nor under any key name at all.
    expect(Object.values(spec?.env ?? {})).not.toContain(GIT_TOKEN);
    // Nor as a host-substituted secret: a placeholder for a git token would
    // still let the guest reach a git host with the host's authority.
    expect(JSON.stringify(spec?.secrets)).not.toContain(GIT_TOKEN);
  });

  it('is absent from every file seeded into the guest', async () => {
    const spec = await captureSandboxSpec();

    expect(JSON.stringify(spec?.files)).not.toContain(GIT_TOKEN);
  });

  it('does hand over the model key, which the harness genuinely needs', async () => {
    const spec = await captureSandboxSpec();

    // The contrast is the point: one credential is made usable because the
    // guest cannot work without it, the other never is because it does not
    // need it.
    expect(spec?.secrets.LLM_API_KEY.value).toBe(MODEL_KEY);
  });

  it('scopes the model key to the model host, and keeps it out of plain env', async () => {
    const spec = await captureSandboxSpec();

    // The guest reads a placeholder under LLM_API_KEY; the real value is
    // substituted host-side, and only for the model endpoint. Putting it in
    // `env` instead would hand the whole key to anything that can read the
    // environment — which is the exfiltration path prompt injection uses.
    expect(spec?.env.LLM_API_KEY).toBeUndefined();
    expect(JSON.stringify(spec?.env)).not.toContain(MODEL_KEY);
    expect(spec?.secrets.LLM_API_KEY.hosts).toEqual(['openrouter.ai']);
  });
});

describe('sandbox runtime gating', () => {
  /**
   * A runtime that has already looked for the package and not found it.
   *
   * The package is now a real dependency of this server, so an unmodified
   * runtime here would boot an actual microVM — a minute of QEMU inside a unit
   * suite, and a green result on a machine with QEMU that says nothing about a
   * machine without it. The failure to load is what these two tests are about,
   * so it is the thing to arrange.
   */
  function runtimeWithNoPackage(): GondolinRuntime {
    const runtime = new GondolinRuntime();

    Object.assign(runtime, { probed: true, module: undefined });

    return runtime;
  }

  it('refuses rather than downgrading when no microVM is available', async () => {
    const availability = await runtimeWithNoPackage().availability();

    // A refusal with a reason someone can act on, not a silent fallback to a
    // container.
    expect(availability.available).toBe(false);
    expect(availability.reason).toMatch(/microVM|not installed|BYO/i);
  });

  it('throws rather than creating a weaker sandbox', async () => {
    await expect(
      runtimeWithNoPackage().create({
        runId: 'run-1',
        files: {},
        env: {},
        secrets: {},
        limits: {
          maxDurationMs: 1000,
          memoryMb: 512,
          diskMb: 1024,
          cpus: 1,
          maxLogBytes: 1024,
        },
        egress: { allow: [] },
      }),
    ).rejects.toThrow();
  });

  // The counterpart — "reports itself available once the package is
  // installed" — cannot live here. Jest runs specs inside a VM context where
  // dynamic import needs --experimental-vm-modules, so this suite sees the
  // load fail for a reason that has nothing to do with the sandbox. It is
  // checked against the running server instead, through
  // `GET /v1/agent-runs/meta/executors`.
});

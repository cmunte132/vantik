import { CredentialsService } from './credentials.service';

/**
 * Which model key a run gets, and where it comes from.
 *
 * Two boundaries meet here. Vantik's own AI features run on the deployment's
 * key; an agent run never does, and never inherits one — an agent works an
 * issue for as long as it takes and spends accordingly, so somebody in the
 * workspace configures a key deliberately or agent runs do not happen.
 *
 * And a key is useless without knowing whose it is: the provider decides the
 * environment variable the harness reads it from and the host the sandbox may
 * reach. So `revealModelKey` hands back both or neither.
 */
describe('CredentialsService model access', () => {
  const SECRET = 'sk-workspace-owned-key-value';

  /**
   * A real sealed row, produced by the service's own encryption.
   *
   * Round-tripped rather than stubbed: `revealModelKey` decrypts for real, and
   * a fake ciphertext would only prove that a mock returns what it was given.
   * A git token is used to make it because storing a model key calls out to
   * the provider, which is a different test.
   */
  async function sealed(): Promise<{
    ciphertext: string;
    nonce: string;
    tag: string;
  }> {
    const stored: Record<string, string>[] = [];
    const prisma = {
      workspaceCredential: {
        findFirst: async (): Promise<null> => null,
        create: async ({ data }: { data: Record<string, string> }) => {
          stored.push(data);
          return data;
        },
      },
    };

    await new CredentialsService(prisma as never).put({
      workspaceId: 'ws-1',
      kind: 'GIT_TOKEN',
      secret: SECRET,
    });

    const row = stored[0];

    return { ciphertext: row.ciphertext, nonce: row.nonce, tag: row.tag };
  }

  /** A store holding the given credential rows, and nothing else. */
  async function serviceWith(
    rows: Array<{ kind: string; provider?: string }>,
  ) {
    const crypto = await sealed();

    const prisma = {
      workspaceCredential: {
        findFirst: jest.fn(async ({ where }: { where: { kind: string } }) => {
          const row = rows.find((entry) => entry.kind === where.kind);
          return row ? { id: 'cred-1', ...row } : null;
        }),
        findMany: jest.fn(
          async ({
            where,
          }: {
            where: { kind: string; provider?: string };
          }) =>
            rows
              .filter((entry) => entry.kind === where.kind)
              .filter(
                (entry) =>
                  !where.provider || entry.provider === where.provider,
              )
              .map((entry) => ({
                id: 'cred-1',
                provider: entry.provider ?? '',
                baseUrl: null as string | null,
                ...crypto,
                ...entry,
              })),
        ),
      },
    };

    return new CredentialsService(prisma as never);
  }

  it('reports the workspace as the source when it holds its own key', async () => {
    const service = await serviceWith([
      { kind: 'MODEL_API_KEY', provider: 'anthropic' },
    ]);

    await expect(service.modelAccess('ws-1')).resolves.toEqual({
      source: 'workspace',
    });
  });

  it('reports no source when the workspace has configured nothing', async () => {
    const service = await serviceWith([]);

    await expect(service.modelAccess('ws-1')).resolves.toEqual({
      source: 'none',
    });
  });

  it('never reports a source from the git token', async () => {
    // Only a model key answers this question. A workspace that has configured
    // repository access and nothing else still cannot run a model.
    const service = await serviceWith([{ kind: 'GIT_TOKEN' }]);

    await expect(service.modelAccess('ws-1')).resolves.toEqual({
      source: 'none',
    });
  });

  it('grants nothing from the deployment environment', async () => {
    // The boundary this file exists for. `LLM_API_KEY` drives Vantik's own AI
    // features; an agent run must never inherit it. There was also once a
    // host-supplied fallback variable honoured here, which was removed for the
    // same reason and is not reintroduced by this passing.
    const previous = process.env.LLM_API_KEY;
    process.env.LLM_API_KEY = 'sk-app-native';

    try {
      const service = await serviceWith([]);

      await expect(service.modelAccess('ws-1')).resolves.toEqual({
        source: 'none',
      });
      await expect(service.revealModelKey('ws-1')).resolves.toBeNull();
    } finally {
      restore('LLM_API_KEY', previous);
    }
  });

  it('hands a run the key together with the provider it belongs to', async () => {
    // The provider is not decoration. Without it the caller cannot know which
    // environment variable the harness reads the key from, which is exactly
    // how a stored key once reached the sandbox under a name nothing read.
    const service = await serviceWith([
      { kind: 'MODEL_API_KEY', provider: 'anthropic' },
    ]);

    await expect(service.revealModelKey('ws-1')).resolves.toMatchObject({
      provider: 'anthropic',
    });
  });

  it('hands a run nothing when there is nothing to hand it', async () => {
    const service = await serviceWith([]);

    await expect(service.revealModelKey('ws-1')).resolves.toBeNull();
  });

  it('gives a run the provider it asked for', async () => {
    const service = await serviceWith([
      { kind: 'MODEL_API_KEY', provider: 'anthropic' },
      { kind: 'MODEL_API_KEY', provider: 'openai' },
    ]);

    await expect(
      service.revealModelKey('ws-1', 'openai'),
    ).resolves.toMatchObject({ provider: 'openai' });
  });

  it('refuses to choose when several are configured and none was named', async () => {
    // Picking one would spend the workspace's money at a company it did not
    // choose for this run. A refused run is recoverable; a bill is not.
    const service = await serviceWith([
      { kind: 'MODEL_API_KEY', provider: 'anthropic' },
      { kind: 'MODEL_API_KEY', provider: 'openai' },
    ]);

    await expect(service.revealModelKey('ws-1')).resolves.toBeNull();
  });

  it('does not need to be told when there is only one', async () => {
    // The common case, and the one that should need no configuration at all.
    const service = await serviceWith([
      { kind: 'MODEL_API_KEY', provider: 'anthropic' },
    ]);

    await expect(service.revealModelKey('ws-1')).resolves.toMatchObject({
      provider: 'anthropic',
    });
  });

  it('agrees with what modelAccess reported, for a single provider', async () => {
    // A run must never fail for a reason the settings screen said was
    // satisfied, and must never be refused a key the screen said existed.
    for (const stored of [
      [],
      [{ kind: 'MODEL_API_KEY', provider: 'anthropic' }],
    ]) {
      const service = await serviceWith(stored);

      const access = await service.modelAccess('ws-1');
      const key = await service.revealModelKey('ws-1');

      expect(Boolean(key)).toBe(access.source !== 'none');
    }
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

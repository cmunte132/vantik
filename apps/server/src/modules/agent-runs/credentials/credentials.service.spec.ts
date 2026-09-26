import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';

import { CredentialsService } from './credentials.service';

const CURRENT_KEY = 'test-suite-encryption-key-of-enough-length';

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

  // `sealed` below runs the service's real encryption, which needs a key.
  // Set here rather than taken from the machine, so the suite does not pass on
  // a developer's `.env` and fail on CI.
  let previousKey: string | undefined;

  beforeAll(() => {
    previousKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
    process.env.CREDENTIAL_ENCRYPTION_KEY = CURRENT_KEY;
  });

  afterAll(() => {
    restore('CREDENTIAL_ENCRYPTION_KEY', previousKey);
  });

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

  describe('the model list the delegation sheet reads', () => {
    /** A store whose model keys carry catalogues, as a stored key does. */
    function serviceWithCatalogues(
      rows: Array<{ provider: string; models: unknown }>,
    ) {
      const prisma = {
        workspaceCredential: {
          findMany: jest.fn(async () => rows),
        },
      };

      return new CredentialsService(prisma as never);
    }

    it('flattens each provider’s catalogue into one list of choices', async () => {
      const service = serviceWithCatalogues([
        {
          provider: 'openrouter',
          // The shape a stored catalogue actually has: id and label, nothing
          // else. Checked against a real row in the dev database.
          models: [
            { id: '~anthropic/claude-fable-latest', label: '~anthropic/claude-fable-latest' },
            { id: 'google/gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
          ],
        },
      ]);

      expect(await service.models('ws-1')).toEqual([
        {
          provider: 'openrouter',
          id: '~anthropic/claude-fable-latest',
          label: '~anthropic/claude-fable-latest',
        },
        {
          provider: 'openrouter',
          id: 'google/gemini-3.6-flash',
          label: 'Gemini 3.6 Flash',
        },
      ]);
    });

    it('survives a key stored without a catalogue', async () => {
      // Ordinary: a provider with no catalogue endpoint stores a working key
      // and no list, and one whose provider was unreachable stores null. The
      // provider still has to appear in the picker, which is why the sheet
      // reads providers separately from models.
      const service = serviceWithCatalogues([
        { provider: 'google', models: null },
        { provider: '', models: [] },
      ]);

      expect(await service.models('ws-1')).toEqual([]);
    });

    it('falls back to the id when the provider named no label', async () => {
      const service = serviceWithCatalogues([
        { provider: 'openai', models: [{ id: 'gpt-5' }] },
      ]);

      expect(await service.models('ws-1')).toEqual([
        { provider: 'openai', id: 'gpt-5', label: 'gpt-5' },
      ]);
    });
  });
});

/**
 * The key, and the credentials sealed before it was required.
 *
 * A server with no key once sealed under SUPERTOKEN_CONNECTION_URI, which a
 * default install sets to a value printed in the compose file. Requiring a key
 * is only half the fix; the rows already written have to move onto it, or
 * turning the key on breaks every workspace's agent runs.
 */
describe('CredentialsService encryption key', () => {
  const ENV = [
    'CREDENTIAL_ENCRYPTION_KEY',
    'SUPERTOKEN_CONNECTION_URI',
    'DATABASE_URL',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of ENV) {
      saved[name] = process.env[name];
    }
    process.env.CREDENTIAL_ENCRYPTION_KEY = CURRENT_KEY;
    // What a server run on the host has, while the rows below were sealed by
    // the compose server. The two disagree on this dev machine, and could on
    // any install that moved between them.
    process.env.SUPERTOKEN_CONNECTION_URI = 'http://localhost:3567';
    process.env.DATABASE_URL =
      'postgresql://docker:docker@localhost:5432/vantik';
  });

  afterEach(() => {
    for (const name of ENV) {
      restore(name, saved[name]);
    }
  });

  interface Row {
    id: string;
    ciphertext: string;
    nonce: string;
    tag: string;
    deleted: Date | null;
  }

  function store(rows: Row[]) {
    const writes: Array<{ where: Record<string, unknown>; data: Row }> = [];
    const prisma = {
      workspaceCredential: {
        findMany: jest.fn(async () => rows),
        updateMany: jest.fn(
          async (args: { where: Record<string, unknown>; data: Row }) => {
            writes.push(args);
            return { count: 1 };
          },
        ),
      },
    };

    return {
      service: new CredentialsService(prisma as never),
      prisma,
      writes,
    };
  }

  function row(
    sealed: Omit<Row, 'id' | 'deleted'>,
    over: Partial<Row> = {},
  ): Row {
    return { id: 'cred-1', deleted: null, ...sealed, ...over };
  }

  describe('at start', () => {
    it('refuses to start without one, and says how to make one', async () => {
      delete process.env.CREDENTIAL_ENCRYPTION_KEY;
      const { service } = store([]);

      // SUPERTOKEN_CONNECTION_URI and DATABASE_URL are both set. Neither is
      // taken instead any more.
      await expect(service.onModuleInit()).rejects.toThrow(
        /CREDENTIAL_ENCRYPTION_KEY is not set.*openssl rand -base64 32/,
      );
    });

    it('refuses a key too short to be a secret', async () => {
      process.env.CREDENTIAL_ENCRYPTION_KEY = 'changeme';
      const { service } = store([]);

      await expect(service.onModuleInit()).rejects.toThrow(
        /has 8 characters, and it needs at least 32/,
      );
    });

    it('refuses a key of only whitespace', async () => {
      process.env.CREDENTIAL_ENCRYPTION_KEY = ' '.repeat(40);
      const { service } = store([]);

      await expect(service.onModuleInit()).rejects.toThrow(/is not set/);
    });

    it('still starts when the credentials cannot be read', async () => {
      // The next start tries again, and until then a row sealed the old way
      // is still readable under the old key.
      const { service, prisma } = store([]);
      prisma.workspaceCredential.findMany.mockRejectedValueOnce(
        new Error('relation "WorkspaceCredential" does not exist'),
      );

      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });
  });

  describe('moving old credentials onto it', () => {
    it('re-seals a credential the compose server sealed under its default', async () => {
      const old = sealWith('http://supertokens:3567', 'sk-old-key');
      const { service, writes } = store([row(old)]);

      await expect(service.resealLegacyCredentials()).resolves.toEqual({
        resealed: 1,
        unreadable: 0,
      });
      expect(openWith(CURRENT_KEY, writes[0].data)).toBe('sk-old-key');
    });

    it('re-seals one sealed under whatever this server was started with', async () => {
      process.env.SUPERTOKEN_CONNECTION_URI = 'https://auth.example.com';
      const old = sealWith('https://auth.example.com', 'ghp-old-token');
      const { service, writes } = store([row(old)]);

      await service.resealLegacyCredentials();

      expect(openWith(CURRENT_KEY, writes[0].data)).toBe('ghp-old-token');
    });

    it('re-seals one sealed under the database url', async () => {
      const old = sealWith(process.env.DATABASE_URL as string, 'sk-db-url');
      const { service, writes } = store([row(old)]);

      await service.resealLegacyCredentials();

      expect(openWith(CURRENT_KEY, writes[0].data)).toBe('sk-db-url');
    });

    it('does not overwrite a key saved since it was read', async () => {
      const old = sealWith('http://supertokens:3567', 'sk-old-key');
      const { service, writes } = store([row(old)]);

      await service.resealLegacyCredentials();

      // Matching on the ciphertext is what makes the write lose to a newer
      // save, instead of putting the old secret back over it.
      expect(writes[0].where).toEqual({
        id: 'cred-1',
        ciphertext: old.ciphertext,
      });
    });

    it('leaves a credential already under the key alone', async () => {
      const current = sealWith(CURRENT_KEY, 'sk-new-key');
      const { service, prisma } = store([row(current)]);

      await expect(service.resealLegacyCredentials()).resolves.toEqual({
        resealed: 0,
        unreadable: 0,
      });
      expect(prisma.workspaceCredential.updateMany).not.toHaveBeenCalled();
    });

    it('moves a removed credential too', async () => {
      const old = sealWith('http://supertokens:3567', 'sk-removed');
      const { service, writes } = store([
        row(old, { deleted: new Date('2026-09-01') }),
      ]);

      await service.resealLegacyCredentials();

      expect(openWith(CURRENT_KEY, writes[0].data)).toBe('sk-removed');
    });

    it('counts a live credential no key opens, and writes nothing', async () => {
      const lost = sealWith('a-key-this-server-never-had', 'sk-lost');
      const { service, prisma } = store([
        row(lost, { id: 'cred-live' }),
        row(lost, { id: 'cred-removed', deleted: new Date('2026-09-01') }),
      ]);

      await expect(service.resealLegacyCredentials()).resolves.toEqual({
        resealed: 0,
        unreadable: 1,
      });
      expect(prisma.workspaceCredential.updateMany).not.toHaveBeenCalled();
    });

    it('seals what it saves from now on under the key', async () => {
      const stored: Row[] = [];
      const prisma = {
        workspaceCredential: {
          findFirst: async (): Promise<null> => null,
          create: async ({ data }: { data: Row }) => {
            stored.push(data);
            return data;
          },
        },
      };

      await new CredentialsService(prisma as never).put({
        workspaceId: 'ws-1',
        kind: 'GIT_TOKEN',
        secret: 'ghp-fresh-token',
      });

      expect(openWith(CURRENT_KEY, stored[0])).toBe('ghp-fresh-token');
    });
  });
});

/**
 * The on-disk format, written out independently of the service.
 *
 * So these tests prove the service still reads what older servers wrote, not
 * merely that it agrees with itself.
 */
function keyFrom(secret: string): Buffer {
  return scryptSync(secret, 'vantik-workspace-credential', 32);
}

function sealWith(secret: string, value: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), nonce);
  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]).toString('hex');

  return {
    ciphertext,
    nonce: nonce.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
  };
}

function openWith(
  secret: string,
  sealed: { ciphertext: string; nonce: string; tag: string },
): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    keyFrom(secret),
    Buffer.from(sealed.nonce, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, 'hex'));

  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

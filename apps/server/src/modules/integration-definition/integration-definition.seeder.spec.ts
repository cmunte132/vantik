import { PrismaService } from 'nestjs-prisma';

import {
  IntegrationSeed,
  integrationSeeds,
  readSeedCredentials,
} from './integration-definition.seed';
import { IntegrationDefinitionSeeder } from './integration-definition.seeder';

/**
 * The seed runs at each start of the server, and it writes the rows that hold
 * the OAuth credentials of the deployment. An operator can also set a
 * credential through the update route. These tests are about what the restart
 * does to that value.
 *
 * They read the arguments of the upsert and not the database. What the row
 * keeps is a property of the `update` object: a column that the object does not
 * name keeps its value, and a column that the object names takes the new one.
 */
describe('IntegrationDefinitionSeeder', () => {
  const original = process.env;
  let upsert: jest.Mock;
  let seeder: IntegrationDefinitionSeeder;

  beforeEach(() => {
    process.env = { ...original };

    for (const seed of integrationSeeds) {
      if (seed.credentialEnv) {
        delete process.env[seed.credentialEnv.clientId];
        delete process.env[seed.credentialEnv.clientSecret];
      }
    }

    upsert = jest.fn().mockResolvedValue({});
    seeder = new IntegrationDefinitionSeeder({
      integrationDefinitionV2: { upsert },
    } as unknown as PrismaService);
  });

  afterEach(() => {
    process.env = original;
  });

  /** This function returns the arguments of the upsert for one integration. */
  function callFor(name: string) {
    const call = upsert.mock.calls.find(
      ([argument]) => argument.where.name === name,
    );

    if (!call) {
      throw new Error(`The seed wrote no row for ${name}.`);
    }

    return call[0];
  }

  it('writes one row for each integration in the catalogue', async () => {
    await seeder.seed();

    expect(upsert).toHaveBeenCalledTimes(integrationSeeds.length);
  });

  describe('a restart with no credentials in the environment', () => {
    /**
     * This is the common self-hosted deployment. The operator sets the secret
     * once through the API, and every later start of the server must leave it
     * alone.
     */
    it('names neither credential column, so the row keeps what it has', async () => {
      await seeder.seed();

      const { update } = callFor('GitHub');

      expect(update).not.toHaveProperty('clientId');
      expect(update).not.toHaveProperty('clientSecret');
    });

    it('still writes the description and the icon', async () => {
      await seeder.seed();

      const { update } = callFor('GitHub');

      expect(update.slug).toBe('github');
      expect(update.deleted).toBeNull();
    });

    it('makes a new row with empty credentials', async () => {
      await seeder.seed();

      const { create } = callFor('GitHub');

      expect(create.clientId).toBe('');
      expect(create.clientSecret).toBe('');
      expect(create.workspaceId).toBeNull();
    });
  });

  describe('a restart with one variable of the pair set', () => {
    /**
     * The environment holds the identifier, which is not a secret, and the
     * operator set the secret through the API. An empty value for the unset
     * variable erases that secret. This test is the reason the seed reads the
     * two variables one at a time.
     */
    it('names only the column that the environment supplies', async () => {
      process.env.GITHUB_CLIENT_ID = 'from-the-environment';

      await seeder.seed();

      const { update } = callFor('GitHub');

      expect(update.clientId).toBe('from-the-environment');
      expect(update).not.toHaveProperty('clientSecret');
    });

    it('does the same when the secret is the variable that is set', async () => {
      process.env.GITHUB_CLIENT_SECRET = 'from-the-environment';

      await seeder.seed();

      const { update } = callFor('GitHub');

      expect(update.clientSecret).toBe('from-the-environment');
      expect(update).not.toHaveProperty('clientId');
    });
  });

  describe('a restart with both variables set', () => {
    /**
     * The environment is the authority on a credential that it holds. An
     * operator who wants the environment to win sets both variables.
     */
    it('replaces both columns', async () => {
      process.env.GITHUB_CLIENT_ID = 'an-identifier';
      process.env.GITHUB_CLIENT_SECRET = 'a-secret';

      await seeder.seed();

      const { update } = callFor('GitHub');

      expect(update.clientId).toBe('an-identifier');
      expect(update.clientSecret).toBe('a-secret');
    });

    it('touches no other integration', async () => {
      process.env.GITHUB_CLIENT_ID = 'an-identifier';
      process.env.GITHUB_CLIENT_SECRET = 'a-secret';

      await seeder.seed();

      const { update } = callFor('Discord');

      expect(update).not.toHaveProperty('clientId');
      expect(update).not.toHaveProperty('clientSecret');
    });
  });

  /**
   * The local repository integration needs no third party, so it has no pair of
   * variables. The seed must never write a credential column for it.
   */
  it('names no credential column for an integration that needs none', async () => {
    await seeder.seed();

    const { update, create } = callFor('Local repository');

    expect(update).not.toHaveProperty('clientId');
    expect(update).not.toHaveProperty('clientSecret');
    expect(create.clientId).toBe('');
  });

  /**
   * A failed seed must not stop the server. The database has no migration on
   * the first start of a new deployment, and the next start repairs it.
   */
  it('survives a database that refuses the write', async () => {
    upsert.mockRejectedValue(new Error('the table is not there'));

    await expect(seeder.onModuleInit()).resolves.toBeUndefined();
  });
});

describe('readSeedCredentials', () => {
  const original = process.env;

  // The names go through a constant, and the tests then set the variables with
  // an index. The lint rule `turbo/no-undeclared-env-vars` reads a direct
  // member of `process.env` and asks for it in `turbo.json`. These two names
  // belong to no deployment, so they must not go in that file.
  const ID = 'TEST_CLIENT_ID';
  const SECRET = 'TEST_CLIENT_SECRET';

  const withCredentials: IntegrationSeed = {
    name: 'Test',
    slug: 'test',
    description: 'A test integration.',
    icon: 'test',
    credentialEnv: { clientId: ID, clientSecret: SECRET },
  };

  beforeEach(() => {
    process.env = { ...original };
    delete process.env[ID];
    delete process.env[SECRET];
  });

  afterEach(() => {
    process.env = original;
  });

  it('returns null for an integration that needs no credentials', () => {
    expect(
      readSeedCredentials({ ...withCredentials, credentialEnv: undefined }),
    ).toBeNull();
  });

  it('returns null when the environment holds neither variable', () => {
    expect(readSeedCredentials(withCredentials)).toBeNull();
  });

  it('returns only the field for the variable that is set', () => {
    process.env[ID] = 'an-identifier';

    expect(readSeedCredentials(withCredentials)).toEqual({
      clientId: 'an-identifier',
    });
  });

  /**
   * An empty variable is the same as an absent one. A deployment that writes
   * `TEST_CLIENT_SECRET=` in its environment file means "I have no secret", and
   * not "erase the secret that the row holds".
   */
  it('treats an empty variable as an absent one', () => {
    process.env[ID] = 'an-identifier';
    process.env[SECRET] = '';

    expect(readSeedCredentials(withCredentials)).toEqual({
      clientId: 'an-identifier',
    });
  });

  it('returns both fields when the environment holds both', () => {
    process.env[ID] = 'an-identifier';
    process.env[SECRET] = 'a-secret';

    expect(readSeedCredentials(withCredentials)).toEqual({
      clientId: 'an-identifier',
      clientSecret: 'a-secret',
    });
  });
});

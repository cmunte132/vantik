/**
 * The integrations that this deployment ships.
 *
 * A row in `IntegrationDefinitionV2` is what makes an integration visible. The
 * server imports the code of an integration by the `slug` of its row, so each
 * slug here must be the name of a directory in `apps/server/src/integrations`.
 *
 * Every row is global, because its `workspaceId` is null. The list query gives
 * a global row to each workspace. The `name` column is unique in the whole
 * database, so a separate row for each workspace is not possible.
 */

export interface IntegrationSeed {
  /** The unique name of the row, and the title on the card. */
  name: string;

  /** The directory in `apps/server/src/integrations` that holds the code. */
  slug: string;

  description: string;

  /** A key of `ICON_MAPPING` in the webapp. An unknown key gets a fallback. */
  icon: string;

  /**
   * The two environment variables that hold the OAuth credentials of this
   * deployment. An integration that needs no third party has no such pair.
   */
  credentialEnv?: {
    clientId: string;
    clientSecret: string;
  };
}

export const integrationSeeds: IntegrationSeed[] = [
  {
    name: 'Local repository',
    slug: 'local-repo',
    description: 'A git repository on the disk of this machine.',
    icon: 'local-repo',
  },

  {
    name: 'Bug Enricher',
    slug: 'bug-enricher',
    description:
      'Suggests a resolution guide when an issue is labelled as a bug, using the deployment model.',
    icon: 'bug',
    // No `credentialEnv`, because there is no third party. This is the plugin
    // that shows the action/integration split was never about what the code
    // *is*: it reaches nothing at all. See ENG-89.
  },
  {
    name: 'GitHub',
    slug: 'github',
    description: 'Repositories and pull requests from GitHub.',
    icon: 'github',
    credentialEnv: {
      clientId: 'GITHUB_CLIENT_ID',
      clientSecret: 'GITHUB_CLIENT_SECRET',
    },
  },
  {
    name: 'Discord',
    slug: 'discord',
    description: 'An issue from a message in a Discord channel.',
    icon: 'discord',
    credentialEnv: {
      clientId: 'DISCORD_CLIENT_ID',
      clientSecret: 'DISCORD_CLIENT_SECRET',
    },
  },
  {
    name: 'Email',
    slug: 'email',
    description: 'An issue from an email that arrives in the workspace.',
    icon: 'email',
    credentialEnv: {
      clientId: 'EMAIL_CLIENT_ID',
      clientSecret: 'EMAIL_CLIENT_SECRET',
    },
  },
];

/**
 * This function reads the OAuth credentials of one integration from the
 * environment. If the integration needs no credentials, or if the environment
 * holds neither of them, this function returns null.
 *
 * The result holds a field only for a variable that the environment sets. The
 * seeder spreads this result over the row at each start of the server, so a
 * field that is present here replaces the value in the database. An empty
 * field for an unset variable erases a credential that an operator set through
 * the API, and one set variable of the pair is enough to make that happen.
 */
export function readSeedCredentials(
  seed: IntegrationSeed,
): Partial<{ clientId: string; clientSecret: string }> | null {
  if (!seed.credentialEnv) {
    return null;
  }

  const clientId = process.env[seed.credentialEnv.clientId];
  const clientSecret = process.env[seed.credentialEnv.clientSecret];

  if (!clientId && !clientSecret) {
    return null;
  }

  return {
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
  };
}

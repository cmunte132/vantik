import { LocalStorageProvider } from './providers/local-storage.provider';
import { S3StorageProvider } from './providers/s3-storage.provider';
import {
  RetiredStorageProvider,
  StorageProvider,
  StorageProviderDefinition,
} from './storage-provider.interface';

/**
 * The backend the server uses when STORAGE_PROVIDER is empty. A disk needs no
 * account and no keys, so a new installation works before anyone configures
 * anything.
 */
export const DEFAULT_STORAGE_PROVIDER = 'local';

/**
 * Every backend the server has.
 *
 * To add one: write a class that implements StorageProvider, then add a
 * definition here. Nothing else in the module changes, and the conformance
 * tests run against the new backend as soon as it appears in this list.
 */
export const STORAGE_PROVIDERS: StorageProviderDefinition[] = [
  {
    key: 'local',
    summary: 'Files on a disk that the server mounts.',
    requiredEnv: ['PUBLIC_ATTACHMENT_URL'],
    create: () => new LocalStorageProvider(),
  },
  {
    key: 's3',
    // The 'aws' name came from the time this backend spoke only to Amazon.
    aliases: ['aws'],
    summary:
      'Amazon S3, or any store that answers the S3 protocol: Cloudflare R2, ' +
      'MinIO, DigitalOcean Spaces, Backblaze B2, Wasabi, and the Google Cloud ' +
      'Storage interoperability endpoint. Set S3_ENDPOINT for all but Amazon.',
    requiredEnv: ['BUCKET_NAME', 'AWS_REGION'],
    create: () => new S3StorageProvider(),
  },
];

/**
 * Backends the server had before. An operator who upgrades with one of these
 * names in the environment needs to know where the backend went, so the
 * registry gives the migration and not a list of valid names.
 */
export const RETIRED_STORAGE_PROVIDERS: RetiredStorageProvider[] = [
  {
    key: 'gcp',
    migration:
      'The Google Cloud Storage backend is gone, and the ' +
      '@google-cloud/storage dependency with it. Google Cloud Storage still ' +
      'works through the S3 backend, which speaks to it over the ' +
      'interoperability endpoint.\n\n' +
      'To migrate:\n' +
      '  1. Make an HMAC key for the service account that holds the bucket:\n' +
      '     Cloud Console > Cloud Storage > Settings > Interoperability.\n' +
      '  2. STORAGE_PROVIDER=s3\n' +
      '  3. S3_ENDPOINT=https://storage.googleapis.com\n' +
      '  4. AWS_REGION=auto\n' +
      '  5. AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY take the HMAC key ' +
      'and secret.\n' +
      '  6. BUCKET_NAME stays as it is. The files do not move.\n\n' +
      'GCP_SERVICE_ACCOUNT_FILE has no effect and you can remove it.',
  },
];

function describeChoices(): string {
  return STORAGE_PROVIDERS.map((definition) => {
    const names = [definition.key, ...(definition.aliases ?? [])].join(' | ');
    return `  ${names}\n      ${definition.summary}`;
  }).join('\n');
}

function findDefinition(key: string): StorageProviderDefinition | undefined {
  return STORAGE_PROVIDERS.find(
    (definition) =>
      definition.key === key || (definition.aliases ?? []).includes(key),
  );
}

/**
 * Chooses the backend and makes it.
 *
 * This runs while the server starts, so a mistake in the configuration stops
 * the server with a message that names it. That matters more than it looks:
 * before this check existed, a server with no storage configuration started
 * clean, passed its health check, and then failed on the first file a user
 * sent.
 */
export function createStorageProvider(): StorageProvider {
  const requested = (
    process.env.STORAGE_PROVIDER || DEFAULT_STORAGE_PROVIDER
  ).toLowerCase();

  const retired = RETIRED_STORAGE_PROVIDERS.find(
    (entry) => entry.key === requested,
  );
  if (retired) {
    throw new Error(
      `STORAGE_PROVIDER=${requested} is no longer available.\n\n${retired.migration}`,
    );
  }

  const definition = findDefinition(requested);
  if (!definition) {
    throw new Error(
      `STORAGE_PROVIDER=${requested} is not a backend this server has.\n\n` +
        `Available backends:\n${describeChoices()}\n\n` +
        `Leave STORAGE_PROVIDER empty to use '${DEFAULT_STORAGE_PROVIDER}'.`,
    );
  }

  const missing = definition.requiredEnv.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `The '${definition.key}' storage backend needs ${missing.join(', ')}, ` +
        `and the environment does not set ${
          missing.length === 1 ? 'it' : 'them'
        }.\n\n` +
        `${definition.summary}`,
    );
  }

  return definition.create();
}

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { LocalStorageProvider } from './providers/local-storage.provider';
import { S3StorageProvider } from './providers/s3-storage.provider';
import {
  createStorageProvider,
  DEFAULT_STORAGE_PROVIDER,
  STORAGE_PROVIDERS,
} from './storage.registry';

describe('storage registry', () => {
  const original = process.env;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vantik-registry-'));
    process.env = {
      ...original,
      STORAGE_PROVIDER: undefined,
      LOCAL_STORAGE_PATH: root,
      PUBLIC_ATTACHMENT_URL: 'http://localhost:3000/api',
      ATTACHMENT_URL_SECRET: 'secret-for-tests',
    };
  });

  afterEach(() => {
    process.env = original;
    rmSync(root, { recursive: true, force: true });
  });

  it('uses the local backend when STORAGE_PROVIDER is empty', () => {
    delete process.env.STORAGE_PROVIDER;

    expect(DEFAULT_STORAGE_PROVIDER).toBe('local');
    expect(createStorageProvider()).toBeInstanceOf(LocalStorageProvider);
  });

  it('still answers to the old aws name', () => {
    process.env.STORAGE_PROVIDER = 'aws';
    process.env.BUCKET_NAME = 'files';
    process.env.AWS_REGION = 'us-east-1';

    expect(createStorageProvider()).toBeInstanceOf(S3StorageProvider);
  });

  it('ignores the case of the name', () => {
    process.env.STORAGE_PROVIDER = 'LOCAL';

    expect(createStorageProvider()).toBeInstanceOf(LocalStorageProvider);
  });

  describe('when the configuration is wrong', () => {
    it('stops, and names the variables the backend needs', () => {
      process.env.STORAGE_PROVIDER = 's3';
      delete process.env.BUCKET_NAME;
      delete process.env.AWS_REGION;

      expect(() => createStorageProvider()).toThrow(
        /needs BUCKET_NAME, AWS_REGION/,
      );
    });

    it('names only the variable that is missing', () => {
      process.env.STORAGE_PROVIDER = 's3';
      process.env.AWS_REGION = 'us-east-1';
      delete process.env.BUCKET_NAME;

      const failure = (() => {
        try {
          createStorageProvider();
          return '';
        } catch (error) {
          return (error as Error).message;
        }
      })();

      expect(failure).toContain('BUCKET_NAME');
      expect(failure).not.toContain('AWS_REGION');
    });

    it('lists the backends it has when the name is unknown', () => {
      process.env.STORAGE_PROVIDER = 'dropbox';

      expect(() => createStorageProvider()).toThrow(/Available backends/);
    });

    // The point of the whole registry: a server with no storage configuration
    // used to start clean and fail on the first file a user sent.
    it('does not make a provider when the configuration is incomplete', () => {
      process.env.STORAGE_PROVIDER = 's3';
      delete process.env.BUCKET_NAME;
      delete process.env.AWS_REGION;

      expect(() => createStorageProvider()).toThrow();
    });
  });

  describe('the gcp backend that the server no longer has', () => {
    beforeEach(() => {
      process.env.STORAGE_PROVIDER = 'gcp';
    });

    it('gives the migration, not "unknown backend"', () => {
      expect(() => createStorageProvider()).toThrow(/interoperability/);
      expect(() => createStorageProvider()).not.toThrow(/Available backends/);
    });

    it('gives the settings the operator must write', () => {
      const failure = (() => {
        try {
          createStorageProvider();
          return '';
        } catch (error) {
          return (error as Error).message;
        }
      })();

      expect(failure).toContain('STORAGE_PROVIDER=s3');
      expect(failure).toContain('https://storage.googleapis.com');
      expect(failure).toContain('BUCKET_NAME stays as it is');
    });
  });

  describe('every registered backend', () => {
    it('has a key, a summary, and no key that repeats', () => {
      const names = STORAGE_PROVIDERS.flatMap((definition) => [
        definition.key,
        ...(definition.aliases ?? []),
      ]);

      for (const definition of STORAGE_PROVIDERS) {
        expect(definition.key).toBeTruthy();
        expect(definition.summary).toBeTruthy();
      }

      expect(new Set(names).size).toBe(names.length);
    });
  });
});

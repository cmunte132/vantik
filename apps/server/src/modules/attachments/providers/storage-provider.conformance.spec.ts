import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { StorageProvider } from '../storage-provider.interface';
import { LocalStorageProvider } from './local-storage.provider';
import { S3StorageProvider } from './s3-storage.provider';

/**
 * One suite that every backend must pass.
 *
 * A backend is only useful if the rest of the server can treat it like all the
 * others, so the checks live here once and each backend runs through them. Add
 * a backend to this list when you add it to the registry.
 */
interface Backend {
  name: string;
  /** Prepares the environment and makes the provider. */
  start: () => StorageProvider;
  stop: () => void;
}

function localBackend(): Backend {
  let root: string;
  const original = process.env;

  return {
    name: 'local',
    start: () => {
      root = mkdtempSync(join(tmpdir(), 'vantik-conformance-'));
      process.env = {
        ...original,
        LOCAL_STORAGE_PATH: root,
        PUBLIC_ATTACHMENT_URL: 'http://localhost:3000/api',
        ATTACHMENT_URL_SECRET: 'secret-for-conformance',
      };
      return new LocalStorageProvider();
    },
    stop: () => {
      process.env = original;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Runs against MinIO, or any other store that answers the S3 protocol. It is
 * skipped unless the environment points at one, because a unit test run must
 * not need a server. `docker compose up minio` and TEST_S3_ENDPOINT turn it on.
 */
function s3Backend(): Backend {
  const original = process.env;

  return {
    name: 's3',
    start: () => {
      process.env = {
        ...original,
        S3_ENDPOINT: process.env.TEST_S3_ENDPOINT,
        S3_FORCE_PATH_STYLE: 'true',
        AWS_REGION: process.env.TEST_S3_REGION || 'us-east-1',
        AWS_ACCESS_KEY_ID: process.env.TEST_S3_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: process.env.TEST_S3_SECRET_ACCESS_KEY,
        BUCKET_NAME: process.env.TEST_S3_BUCKET,
      };
      return new S3StorageProvider();
    },
    stop: () => {
      process.env = original;
    },
  };
}

const backends: Backend[] = [
  localBackend(),
  ...(process.env.TEST_S3_ENDPOINT ? [s3Backend()] : []),
];

describe.each(backends)('$name storage backend', (backend: Backend) => {
  const path = 'workspace-1/attachment-1.png';
  const contents = Buffer.from('the bytes of a small picture');

  let provider: StorageProvider;

  beforeEach(() => {
    provider = backend.start();
  });

  afterEach(async () => {
    try {
      await provider.deleteFile(path);
    } catch {
      // Not every test writes the file, and a backend may object.
    }
    backend.stop();
  });

  describe('uploadFile and downloadFile', () => {
    it('gives back the bytes it was given', async () => {
      await provider.uploadFile(path, contents, { contentType: 'image/png' });

      expect(await provider.downloadFile(path)).toEqual(contents);
    });

    it('replaces the file when the same path is written again', async () => {
      const second = Buffer.from('different bytes');

      await provider.uploadFile(path, contents, { contentType: 'image/png' });
      await provider.uploadFile(path, second, { contentType: 'image/png' });

      expect(await provider.downloadFile(path)).toEqual(second);
    });
  });

  describe('fileExists', () => {
    it('is true after a write', async () => {
      await provider.uploadFile(path, contents, { contentType: 'image/png' });

      expect(await provider.fileExists(path)).toBe(true);
    });

    // A missing file must answer false, not throw. The service asks this
    // question before every read and every delete.
    it('is false for a file that was never written', async () => {
      expect(await provider.fileExists('workspace-1/absent.png')).toBe(false);
    });
  });

  describe('getMetadata', () => {
    it('reports the size in bytes', async () => {
      await provider.uploadFile(path, contents, { contentType: 'image/png' });

      expect((await provider.getMetadata(path)).size).toBe(contents.length);
    });

    it('reports the content type that was given at upload', async () => {
      await provider.uploadFile(path, contents, { contentType: 'image/png' });

      expect((await provider.getMetadata(path)).contentType).toBe('image/png');
    });
  });

  describe('getSignedUrl', () => {
    it('gives a URL to read with', async () => {
      await provider.uploadFile(path, contents, { contentType: 'image/png' });

      const url = await provider.getSignedUrl(path, {
        action: 'read',
        expires: Date.now() + 60_000,
        responseDisposition: 'inline',
      });

      expect(url).toMatch(/^https?:\/\//);
    });

    it('gives a URL to write with', async () => {
      const url = await provider.getSignedUrl(path, {
        action: 'write',
        expires: Date.now() + 60_000,
        contentType: 'image/png',
      });

      expect(url).toMatch(/^https?:\/\//);
    });

    it('gives a different URL for reading than for writing', async () => {
      const expires = Date.now() + 60_000;

      const read = await provider.getSignedUrl(path, {
        action: 'read',
        expires,
      });
      const write = await provider.getSignedUrl(path, {
        action: 'write',
        expires,
        contentType: 'image/png',
      });

      expect(read).not.toBe(write);
    });
  });

  describe('deleteFile', () => {
    it('removes the file', async () => {
      await provider.uploadFile(path, contents, { contentType: 'image/png' });
      await provider.deleteFile(path);

      expect(await provider.fileExists(path)).toBe(false);
    });

    // Delete runs beside a database write that may already have happened, so
    // a second delete must not turn into an error the user sees.
    it('does not complain about a file that is already gone', async () => {
      await expect(
        provider.deleteFile('workspace-1/absent.png'),
      ).resolves.not.toThrow();
    });
  });
});

describe('local storage backend, paths', () => {
  const backend = localBackend();
  let provider: LocalStorageProvider;

  beforeEach(() => {
    provider = backend.start() as LocalStorageProvider;
  });

  afterEach(() => {
    backend.stop();
  });

  // Paths are built from workspace and attachment identifiers, so none of
  // these can arrive today. The check holds anyway, because the day a caller
  // passes something else is the day it matters.
  it.each([
    ['a parent directory', '../../etc/passwd'],
    ['a parent directory in the middle', 'workspace-1/../../../etc/passwd'],
    ['an absolute path', '/etc/passwd'],
  ])('refuses to write through %s', async (_name, path) => {
    await expect(
      provider.uploadFile(path, Buffer.from('x'), {
        contentType: 'text/plain',
      }),
    ).rejects.toThrow(/escapes the storage root/);
  });

  it('refuses to read through a parent directory', async () => {
    await expect(provider.downloadFile('../../etc/passwd')).rejects.toThrow(
      /escapes the storage root/,
    );
  });

  it('refuses to sign a URL for a path outside the root', async () => {
    await expect(
      provider.getSignedUrl('../../etc/passwd', {
        action: 'read',
        expires: Date.now() + 60_000,
      }),
    ).rejects.toThrow(/escapes the storage root/);
  });

  it('allows a path that stays inside the root', async () => {
    await expect(
      provider.uploadFile('workspace-1/nested/file.png', Buffer.from('x'), {
        contentType: 'image/png',
      }),
    ).resolves.not.toThrow();
  });
});

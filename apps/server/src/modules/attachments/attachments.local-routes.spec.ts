import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { INestApplication, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import request from 'supertest';

import { AttachmentController } from './attachments.controller';
import {
  LOCAL_ATTACHMENT_PATH,
  localAttachmentBodyParser,
} from './attachments.middleware';
import { AttachmentService } from './attachments.service';
import { LocalStorageProvider } from './providers/local-storage.provider';
import { StorageFactory } from './storage.factory';
import { signUrlToken } from './url-signer';

const SECRET = 'secret-for-route-tests';
const FILE_PATH = 'workspace-1/attachment-1.png';
const CONTENTS = Buffer.from('the bytes of a small picture');

/**
 * Drives the routes that serve the URLs the local backend signs. The token
 * carries the whole right to the file, so these checks are the ones that keep
 * a signed URL from becoming a way to read any file the server holds.
 */
describe('the routes that serve locally signed URLs', () => {
  const originalEnv = process.env;
  let app: INestApplication;
  let provider: LocalStorageProvider;
  let root: string;

  /** Takes the token out of a signed URL, the way a client would use it. */
  function tokenOf(url: string): string {
    return url.split('/').pop();
  }

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'vantik-routes-'));
    process.env = {
      ...originalEnv,
      STORAGE_PROVIDER: 'local',
      LOCAL_STORAGE_PATH: root,
      PUBLIC_ATTACHMENT_URL: 'http://localhost:3000/api',
      ATTACHMENT_URL_SECRET: SECRET,
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [AttachmentController],
      providers: [
        AttachmentService,
        StorageFactory,
        // The local routes never reach the database.
        { provide: PrismaService, useValue: {} },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI });
    // The same parser the server applies, taken from the same place.
    app.use(LOCAL_ATTACHMENT_PATH, localAttachmentBodyParser());
    await app.init();

    // The registry chose this, so the test signs with the same instance and
    // the same secret the routes verify against.
    provider = app.get(AttachmentService)[
      'storageProvider'
    ] as LocalStorageProvider;
  });

  afterEach(async () => {
    await app.close();
    process.env = originalEnv;
    rmSync(root, { recursive: true, force: true });
  });

  describe('a client that follows the signed URL', () => {
    it('reads the file back, with the type it was stored under', async () => {
      await provider.uploadFile(FILE_PATH, CONTENTS, {
        contentType: 'image/png',
      });
      const url = await provider.getSignedUrl(FILE_PATH, {
        action: 'read',
        expires: Date.now() + 60_000,
      });

      const response = await request(app.getHttpServer())
        .get(`/v1/attachment/local/${tokenOf(url)}`)
        .expect(200);

      expect(response.headers['content-type']).toContain('image/png');
      expect(response.body).toEqual(CONTENTS);
    });

    it('uploads with a write URL, and reads back what it sent', async () => {
      const writeUrl = await provider.getSignedUrl(FILE_PATH, {
        action: 'write',
        expires: Date.now() + 60_000,
        contentType: 'image/png',
      });

      await request(app.getHttpServer())
        .put(`/v1/attachment/local/${tokenOf(writeUrl)}`)
        .set('Content-Type', 'image/png')
        .send(CONTENTS)
        .expect(200);

      // The bytes went to storage, not into a body parser that dropped them.
      expect(await provider.downloadFile(FILE_PATH)).toEqual(CONTENTS);

      const readUrl = await provider.getSignedUrl(FILE_PATH, {
        action: 'read',
        expires: Date.now() + 60_000,
      });
      const response = await request(app.getHttpServer())
        .get(`/v1/attachment/local/${tokenOf(readUrl)}`)
        .expect(200);

      expect(response.body).toEqual(CONTENTS);
    });

    it('does not let a shared cache keep the answer', async () => {
      await provider.uploadFile(FILE_PATH, CONTENTS, {
        contentType: 'image/png',
      });
      const url = await provider.getSignedUrl(FILE_PATH, {
        action: 'read',
        expires: Date.now() + 60_000,
      });

      const response = await request(app.getHttpServer())
        .get(`/v1/attachment/local/${tokenOf(url)}`)
        .expect(200);

      // The URL expires, so a cache that kept it would outlive the permission.
      expect(response.headers['cache-control']).toContain('no-store');
    });
  });

  describe('a token that must not work', () => {
    beforeEach(async () => {
      await provider.uploadFile(FILE_PATH, CONTENTS, {
        contentType: 'image/png',
      });
    });

    it('refuses a token signed with another secret', async () => {
      const forged = signUrlToken(
        {
          filePath: FILE_PATH,
          action: 'read',
          expires: Date.now() + 60_000,
        },
        'not-the-servers-secret',
      );

      await request(app.getHttpServer())
        .get(`/v1/attachment/local/${forged}`)
        .expect(404);
    });

    it('refuses a token whose claims were changed', async () => {
      const url = await provider.getSignedUrl(FILE_PATH, {
        action: 'read',
        expires: Date.now() + 60_000,
      });
      const [, signature] = tokenOf(url).split('.');
      const claims = Buffer.from(
        JSON.stringify({
          filePath: 'workspace-2/private.pdf',
          action: 'read',
          expires: Date.now() + 60_000,
        }),
        'utf8',
      ).toString('base64url');

      await request(app.getHttpServer())
        .get(`/v1/attachment/local/${claims}.${signature}`)
        .expect(404);
    });

    it('refuses a token whose time has passed', async () => {
      const expired = signUrlToken(
        { filePath: FILE_PATH, action: 'read', expires: Date.now() - 1000 },
        SECRET,
      );

      await request(app.getHttpServer())
        .get(`/v1/attachment/local/${expired}`)
        .expect(404);
    });

    // A token that uploads must not also download, or a client given the right
    // to add one file gains the right to read every file it can name.
    it('refuses a write token used to read', async () => {
      const url = await provider.getSignedUrl(FILE_PATH, {
        action: 'write',
        expires: Date.now() + 60_000,
        contentType: 'image/png',
      });

      await request(app.getHttpServer())
        .get(`/v1/attachment/local/${tokenOf(url)}`)
        .expect(404);
    });

    it('refuses a read token used to write', async () => {
      const url = await provider.getSignedUrl(FILE_PATH, {
        action: 'read',
        expires: Date.now() + 60_000,
      });

      await request(app.getHttpServer())
        .put(`/v1/attachment/local/${tokenOf(url)}`)
        .set('Content-Type', 'image/png')
        .send(Buffer.from('replacement bytes'))
        .expect(404);

      expect(await provider.downloadFile(FILE_PATH)).toEqual(CONTENTS);
    });

    it('refuses a token that is not a token', async () => {
      await request(app.getHttpServer())
        .get('/v1/attachment/local/nonsense')
        .expect(404);
    });

    it('answers 404 for a signed path that holds no file', async () => {
      const url = await provider.getSignedUrl('workspace-1/absent.png', {
        action: 'read',
        expires: Date.now() + 60_000,
      });

      await request(app.getHttpServer())
        .get(`/v1/attachment/local/${tokenOf(url)}`)
        .expect(404);
    });
  });
});

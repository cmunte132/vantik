import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  ExecutionContext,
  INestApplication,
  VersioningType,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from 'nestjs-prisma';
import request from 'supertest';

import { validationPipe } from 'common/validation';

import { AuthGuard } from 'modules/auth/auth.guard';

import { AttachmentController } from './attachments.controller';
import { AttachmentService } from './attachments.service';
import { LocalStorageProvider } from './providers/local-storage.provider';
import { StorageFactory } from './storage.factory';

const USER = 'user-self';
const OWN_WORKSPACE = 'workspace-own';
const OTHER_WORKSPACE = 'workspace-other';
const ATTACHMENT = 'attachment-1';
const CONTENTS = Buffer.from('the bytes of a small picture');

/**
 * Drives the two routes a signed-in member reads a file through, with the
 * request pipe the server runs. The editor links a file as
 * `/attachment/:attachmentId`; an integration's upload links it as
 * `/attachment/:workspaceId/:attachmentId`.
 */
describe('the routes a member reads an attachment through', () => {
  const originalEnv = process.env;
  let app: INestApplication;
  let root: string;
  let prisma: {
    usersOnWorkspaces: { findUnique: jest.Mock };
    attachment: { findFirst: jest.Mock };
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'vantik-read-routes-'));
    process.env = {
      ...originalEnv,
      STORAGE_PROVIDER: 'local',
      LOCAL_STORAGE_PATH: root,
      PUBLIC_ATTACHMENT_URL: 'http://localhost:3000/api',
      ATTACHMENT_URL_SECRET: 'secret-for-route-tests',
    };

    // The caller is a member of OWN_WORKSPACE only, and the one attachment
    // lives there.
    prisma = {
      usersOnWorkspaces: {
        findUnique: jest.fn(async ({ where }) =>
          where.userId_workspaceId.workspaceId === OWN_WORKSPACE
            ? { status: 'ACTIVE' }
            : null,
        ),
      },
      attachment: {
        findFirst: jest.fn(async ({ where }) =>
          where.id === ATTACHMENT && where.workspaceId === OWN_WORKSPACE
            ? {
                id: ATTACHMENT,
                fileExt: 'png',
                fileType: 'image/png',
                originalName: 'picture.png',
              }
            : null,
        ),
      },
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [AttachmentController],
      providers: [
        AttachmentService,
        StorageFactory,
        { provide: PrismaService, useValue: prisma },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          context.switchToHttp().getRequest().session = {
            getAccessTokenPayload: () => ({
              appUserId: USER,
              workspaceId: OWN_WORKSPACE,
            }),
          };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI });
    app.useGlobalPipes(validationPipe());
    await app.init();

    const provider = app.get(AttachmentService)[
      'storageProvider'
    ] as LocalStorageProvider;
    await provider.uploadFile(`${OWN_WORKSPACE}/${ATTACHMENT}.png`, CONTENTS, {
      contentType: 'image/png',
    });
  });

  afterEach(async () => {
    await app.close();
    process.env = originalEnv;
    rmSync(root, { recursive: true, force: true });
  });

  it('serves a file of the caller-s workspace by its id alone', async () => {
    // The params DTO required a workspaceId this path never carries, so every
    // request here answered 400 and no image in the editor ever loaded.
    const response = await request(app.getHttpServer())
      .get(`/v1/attachment/${ATTACHMENT}`)
      .expect(200);

    expect(response.headers['content-type']).toContain('image/png');
    expect(response.body).toEqual(CONTENTS);
  });

  it('serves a file of a workspace the caller belongs to', async () => {
    const response = await request(app.getHttpServer())
      .get(`/v1/attachment/${OWN_WORKSPACE}/${ATTACHMENT}`)
      .expect(200);

    expect(response.body).toEqual(CONTENTS);
  });

  it('refuses a workspace the caller does not belong to', async () => {
    // The path named the workspace and nothing checked it, so any signed-in
    // user could read another workspace's files from their URLs.
    await request(app.getHttpServer())
      .get(`/v1/attachment/${OTHER_WORKSPACE}/${ATTACHMENT}`)
      .expect(404);

    expect(prisma.attachment.findFirst).not.toHaveBeenCalled();
  });

  it('keeps a file out of shared caches', async () => {
    const response = await request(app.getHttpServer())
      .get(`/v1/attachment/${ATTACHMENT}`)
      .expect(200);

    expect(response.headers['cache-control']).toMatch(/^private\b/);
  });
});

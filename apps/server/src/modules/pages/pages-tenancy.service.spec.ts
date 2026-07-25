/**
 * Tenancy scoping for pages and entries.
 *
 * Written in the style of `issues-tenancy.service.spec.ts`, and protecting the
 * same invariant: a read or write is never issued without a workspace, and the
 * workspace it uses is one the caller actually belongs to.
 *
 * Pages raise the stakes over issues. An issue title leaking across tenants is
 * bad; a knowledge bank leaking is worse, because the whole point of the store
 * is that people put the things they would otherwise keep out of a tracker into
 * it — credentials policy, architecture decisions, why a customer left.
 *
 * A foreign id must be indistinguishable from a non-existent one, or the error
 * itself confirms which ids exist in other workspaces.
 */
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import {
  assertPageEntryInWorkspace,
  assertPageInWorkspace,
} from 'common/workspace-access';

import PagesService from './pages.service';

const USER = 'user-1';
const MY_WORKSPACE = 'workspace-mine';
const THEIR_WORKSPACE = 'workspace-theirs';

/** A prisma double whose page rows carry the workspace they belong to. */
function buildPrisma(rows: Array<{ id: string; workspaceId: string }>) {
  const matches = (
    where: { id?: string; workspaceId?: string; deleted?: unknown } = {},
  ) =>
    rows.find(
      (row) =>
        row.id === where.id &&
        (where.workspaceId === undefined ||
          row.workspaceId === where.workspaceId),
    ) ?? null;

  return {
    page: {
      findFirst: jest.fn(({ where }) => Promise.resolve(matches(where))),
      findMany: jest.fn(() => Promise.resolve([])),
      findUnique: jest.fn(({ where }) => Promise.resolve(matches(where))),
      create: jest.fn(({ data }) => Promise.resolve({ id: 'new', ...data })),
      update: jest.fn(({ where, data }) =>
        Promise.resolve({ id: where.id, ...data }),
      ),
    },
    pageEntry: {
      findFirst: jest.fn(({ where }) =>
        Promise.resolve(
          where.page?.workspaceId === MY_WORKSPACE && where.id === 'entry-mine'
            ? { id: 'entry-mine' }
            : null,
        ),
      ),
    },
    pageHistory: { create: jest.fn(() => Promise.resolve({})) },
  } as unknown as PrismaService;
}

describe('page workspace guards', () => {
  it('accepts a page in the caller’s workspace', async () => {
    const prisma = buildPrisma([{ id: 'page-1', workspaceId: MY_WORKSPACE }]);

    await expect(
      assertPageInWorkspace(prisma, 'page-1', MY_WORKSPACE),
    ).resolves.toBeUndefined();
  });

  it('reports a page in another workspace as not found', async () => {
    const prisma = buildPrisma([{ id: 'page-1', workspaceId: THEIR_WORKSPACE }]);

    // Not forbidden: a foreign id and a non-existent one have to look the same,
    // or the error confirms the id exists somewhere.
    await expect(
      assertPageInWorkspace(prisma, 'page-1', MY_WORKSPACE),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reports an entry whose page is in another workspace as not found', async () => {
    const prisma = buildPrisma([]);

    await expect(
      assertPageEntryInWorkspace(prisma, 'entry-theirs', MY_WORKSPACE),
    ).rejects.toBeInstanceOf(NotFoundException);

    await expect(
      assertPageEntryInWorkspace(prisma, 'entry-mine', MY_WORKSPACE),
    ).resolves.toBeUndefined();
  });
});

describe('PagesService tree scoping', () => {
  it('refuses to nest a page under a parent in another workspace', async () => {
    const prisma = buildPrisma([
      { id: 'parent', workspaceId: THEIR_WORKSPACE },
    ]);
    const service = new PagesService(prisma);

    await expect(
      service.createPage(MY_WORKSPACE, USER, {
        title: 'Runbook',
        parentId: 'parent',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    // Nothing may be written when the parent check fails; a page created first
    // and reparented after would be a cross-tenant write with extra steps.
    expect(prisma.page.create).not.toHaveBeenCalled();
  });

  it('scopes a page list to the workspace it was given', async () => {
    const prisma = buildPrisma([]);
    const service = new PagesService(prisma);

    await service.getPages(MY_WORKSPACE);

    const { where } = (prisma.page.findMany as jest.Mock).mock.calls[0][0];
    expect(where.workspaceId).toBe(MY_WORKSPACE);
    expect(where.deleted).toBeNull();
  });
});

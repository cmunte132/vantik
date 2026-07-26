/**
 * The page graph, read from the work rather than from the documentation.
 *
 * `getRelatedPages` is the direction search cannot serve, and it is also what
 * the issue view reads. What is pinned here is the edge id travelling with the
 * page: deletes are scoped by page, so a caller entering from the issue end
 * without it can list the links and not remove one.
 */
import { PageLinkTypeEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import PageLinksService from './page-links.service';

function buildService(
  rows: Array<{
    id: string;
    entityType: string;
    entityId: string;
    page: { id: string; title: string };
  }>,
) {
  const prisma = {
    pageLink: { findMany: jest.fn(() => Promise.resolve(rows)) },
  };

  return {
    service: new PageLinksService(prisma as unknown as PrismaService),
    prisma,
  };
}

describe('getRelatedPages', () => {
  it('carries the edge id alongside the page', async () => {
    const { service } = buildService([
      {
        id: 'link-1',
        entityType: 'ISSUE',
        entityId: 'issue-1',
        page: { id: 'page-1', title: 'Deploying the worker pool' },
      },
    ]);

    const [related] = await service.getRelatedPages(
      PageLinkTypeEnum.ISSUE,
      'issue-1',
      'workspace-1',
    );

    expect(related.id).toBe('page-1');
    expect(related.title).toBe('Deploying the worker pool');
    // Without this the issue view can list a page and not unlink it.
    expect(related.linkId).toBe('link-1');
  });

  it('never reads outside the caller’s workspace', async () => {
    const { service, prisma } = buildService([]);

    await service.getRelatedPages(
      PageLinkTypeEnum.ISSUE,
      'issue-1',
      'workspace-1',
    );

    const { where } = (prisma.pageLink.findMany as jest.Mock).mock.calls[0][0];
    // The edge has no workspace of its own — the page it hangs off is what
    // scopes it, so dropping this relation widens the read to every tenant.
    expect(where.page).toEqual({ deleted: null, workspaceId: 'workspace-1' });
    expect(where.deleted).toBeNull();
  });
});

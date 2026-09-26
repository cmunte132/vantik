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

describe('links to the product graph', () => {
  const product = { id: 'product-1', name: 'Cloud', key: 'cloud' };
  const productModule = { id: 'module-1', name: 'Server', key: 'server' };
  const capability = { id: 'capability-1', name: 'Billing' };

  /** One of each target, and whatever edges the test hands in. */
  function graph(
    edges: Array<{ id: string; entityType: string; entityId: string }>,
  ) {
    const byId = <T extends { id: string }>(rows: T[]) =>
      jest.fn(({ where }) =>
        Promise.resolve(
          rows.filter((row) =>
            where.id.in ? where.id.in.includes(row.id) : row.id === where.id,
          ),
        ),
      );
    const one = <T extends { id: string }>(rows: T[]) =>
      jest.fn(({ where }) =>
        Promise.resolve(rows.find((row) => row.id === where.id) ?? null),
      );

    const prisma = {
      pageLink: {
        findMany: jest.fn(({ where }) =>
          Promise.resolve(
            edges
              .filter(
                (edge) =>
                  !where.entityType ||
                  (edge.entityType === where.entityType &&
                    edge.entityId === where.entityId),
              )
              .map((edge) => ({
                ...edge,
                pageId: 'page-1',
                page: { id: 'page-1', title: 'Billing runbook' },
              })),
          ),
        ),
        upsert: jest.fn(({ create }) =>
          Promise.resolve({ id: 'link-new', ...create }),
        ),
      },
      team: { findMany: byId([]) },
      project: { findMany: byId([]) },
      issue: { findMany: byId([]) },
      page: { findMany: byId([]) },
      product: { findMany: byId([product]), findFirst: one([product]) },
      module: {
        findMany: byId([productModule]),
        findFirst: one([productModule]),
      },
      capability: {
        findMany: byId([capability]),
        findFirst: one([capability]),
      },
    };

    return {
      service: new PageLinksService(prisma as unknown as PrismaService),
      prisma,
    };
  }

  it('[KG-1.1] resolves a link to a product, a module and a capability, with the key its route uses', async () => {
    const { service } = graph([
      { id: 'link-1', entityType: 'PRODUCT', entityId: 'product-1' },
      { id: 'link-2', entityType: 'MODULE', entityId: 'module-1' },
      { id: 'link-3', entityType: 'CAPABILITY', entityId: 'capability-1' },
    ]);

    const links = await service.getLinks('page-1', 'workspace-1');

    expect(links).toEqual([
      expect.objectContaining({
        entityType: PageLinkTypeEnum.PRODUCT,
        label: 'Cloud',
        key: 'cloud',
      }),
      expect.objectContaining({
        entityType: PageLinkTypeEnum.MODULE,
        label: 'Server',
        key: 'server',
      }),
      expect.objectContaining({
        entityType: PageLinkTypeEnum.CAPABILITY,
        label: 'Billing',
      }),
    ]);
  });

  it('[KG-1.1] drops a link whose product, module or capability is gone', async () => {
    const { service, prisma } = graph([
      { id: 'link-1', entityType: 'MODULE', entityId: 'module-deleted' },
      { id: 'link-2', entityType: 'CAPABILITY', entityId: 'capability-1' },
    ]);

    const links = await service.getLinks('page-1', 'workspace-1');

    expect(links.map((link) => link.id)).toEqual(['link-2']);
    // Deleted and foreign rows are excluded in the query, not afterwards.
    const { where } = prisma.module.findMany.mock.calls[0][0];
    expect(where).toMatchObject({ workspaceId: 'workspace-1', deleted: null });
  });

  it('[KG-1.1] links a page to a module that exists, and refuses one that does not', async () => {
    const { service, prisma } = graph([]);

    await expect(
      service.createLink('page-1', 'workspace-1', 'user-1', {
        entityType: PageLinkTypeEnum.MODULE,
        entityId: 'module-1',
      }),
    ).resolves.toMatchObject({ entityType: 'MODULE', label: 'Server' });

    await expect(
      service.createLink('page-1', 'workspace-1', 'user-1', {
        entityType: PageLinkTypeEnum.CAPABILITY,
        entityId: 'capability-missing',
      }),
    ).rejects.toThrow(/No capability capability-missing/);
    expect(prisma.pageLink.upsert).toHaveBeenCalledTimes(1);
  });

  it('[KG-1.1] finds the pages linked to a product from the product', async () => {
    const { service } = graph([
      { id: 'link-1', entityType: 'PRODUCT', entityId: 'product-1' },
    ]);

    const related = await service.getRelatedPages(
      PageLinkTypeEnum.PRODUCT,
      'product-1',
      'workspace-1',
    );

    expect(related).toEqual([
      expect.objectContaining({ id: 'page-1', linkId: 'link-1' }),
    ]);
  });
});

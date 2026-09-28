import type { Client as TypesenseClient } from 'typesense';

import { PageEntryStatusEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { VectorService } from 'modules/vector/vector.service';

import KnowledgeIndexService from './knowledge-index.service';

/**
 * Keeping the index in step with postgres, over the real VectorService and
 * an in-memory index. What is tested here is the repair a boot runs: the
 * consolidated entries the index does not hold are put back, and nothing
 * else is touched.
 */

const WORKSPACE = '0b7b1d0e-5c55-4a9e-9d0e-6f4a8c1b2a01';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function setup(held: string[] = [], options: { exportFails?: boolean } = {}) {
  const entry = (id: string, status: string, overrides: Row = {}): Row => ({
    id,
    status,
    content: `What ${id} says.`,
    scope: null,
    sourceUserId: 'agent-1',
    verifiedAt: null,
    retrievalCount: 0,
    updatedAt: new Date('2026-09-01'),
    pageId: 'page-runbook',
    moduleIds: [],
    kind: 'FACT',
    citations: [],
    deleted: null,
    page: { title: 'Runbook', workspaceId: WORKSPACE, deleted: null },
    ...overrides,
  });
  const entries: Row[] = [
    // Consolidated before consolidated entries were served: taken out of
    // the index then.
    entry('e-folded', PageEntryStatusEnum.CONSOLIDATED),
    // Consolidated since, and indexed as it was.
    entry('e-held', PageEntryStatusEnum.CONSOLIDATED),
    entry('e-deleted', PageEntryStatusEnum.CONSOLIDATED, {
      deleted: new Date('2026-09-02'),
    }),
    entry('e-on-deleted-page', PageEntryStatusEnum.CONSOLIDATED, {
      page: {
        title: 'Old',
        workspaceId: WORKSPACE,
        deleted: new Date('2026-09-02'),
      },
    }),
    entry('e-standing', PageEntryStatusEnum.STANDING),
  ];

  const docs = new Map<string, Row>(
    held.map((id) => [
      `entry:${id}`,
      {
        id: `entry:${id}`,
        kind: 'entry',
        entryId: id,
        status: entries.find((row) => row.id === id)?.status,
      },
    ]),
  );
  const upserted: string[] = [];
  const exports: Row[] = [];
  const typesense = {
    collections: () => ({
      documents: (id?: string) =>
        id
          ? { delete: async () => docs.delete(id) }
          : {
              upsert: async (doc: Row) => {
                upserted.push(doc.id);
                docs.set(doc.id, doc);

                return doc;
              },
              // JSONL, one document a line, as Typesense exports them.
              export: async (params: Row) => {
                exports.push(params);

                if (options.exportFails) {
                  throw new Error('ECONNREFUSED');
                }

                const status = /status:=`(\w+)`/.exec(params.filter_by)?.[1];

                return [...docs.values()]
                  .filter(
                    (doc) => doc.kind === 'entry' && doc.status === status,
                  )
                  .map((doc) => JSON.stringify({ entryId: doc.entryId }))
                  .join('\n');
              },
            },
    }),
  } as unknown as TypesenseClient;

  const matches = (row: Row, where: Row) =>
    (!('deleted' in where) || row.deleted === null) &&
    (!where.status || row.status === where.status) &&
    (!where.page || row.page.deleted === null);
  const prisma = {
    pageEntry: {
      findMany: jest.fn(async ({ where }: Row) =>
        entries
          .filter((row) => matches(row, where))
          .map((row) => ({ id: row.id })),
      ),
      findUnique: jest.fn(
        async ({ where }: Row) =>
          entries.find((row) => row.id === where.id) ?? null,
      ),
    },
  };
  const vectorService = new VectorService(
    prisma as unknown as PrismaService,
    typesense,
  );
  const service = new KnowledgeIndexService(
    prisma as unknown as PrismaService,
    vectorService,
  );

  return { service, prisma, docs, upserted, exports };
}

describe('keeping the index in step', () => {
  it('[KG-7.4] puts back the consolidated entries the index lost, and touches nothing else', async () => {
    const { service, docs, upserted, exports } = setup(['e-held']);

    await expect(service.indexMissingConsolidated()).resolves.toBe(1);

    // Only the entry the index lost is written; it is findable again as
    // what it is, consolidated.
    expect(upserted).toEqual(['entry:e-folded']);
    expect(docs.get('entry:e-folded')).toMatchObject({
      entryId: 'e-folded',
      status: PageEntryStatusEnum.CONSOLIDATED,
      workspaceId: WORKSPACE,
    });
    // The index is asked only for the ids it holds in that status.
    expect(exports).toEqual([
      {
        filter_by: 'kind:=entry && status:=`CONSOLIDATED`',
        include_fields: 'entryId',
      },
    ]);

    // A second pass finds nothing to do, and writes nothing.
    await expect(service.indexMissingConsolidated()).resolves.toBe(0);
    expect(upserted).toEqual(['entry:e-folded']);
  });

  it('[KG-7.4] asks the index nothing when no entry is consolidated, and survives an index that cannot be reached', async () => {
    // Nothing consolidated: the store answers no rows.
    const empty = setup();
    empty.prisma.pageEntry.findMany.mockResolvedValueOnce([]);
    await expect(empty.service.indexMissingConsolidated()).resolves.toBe(0);
    expect(empty.exports).toEqual([]);

    // An index that cannot be reached is logged, and writes nothing; the
    // next boot tries again.
    const down = setup([], { exportFails: true });
    await expect(down.service.indexMissingConsolidated()).resolves.toBe(0);
    expect(down.upserted).toEqual([]);
  });
});

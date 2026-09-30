import { PageLinkType } from '@prisma/client';
import { PageKindEnum, type PageSection } from '@vantikhq/types';
import { Queue } from 'bull';
import { PrismaService } from 'nestjs-prisma';

import { convertTiptapJsonToMarkdown } from 'common/utils/tiptap.utils';

import { VectorService } from 'modules/vector/vector.service';

import PagesService from '../pages.service';
import PageRefreshService from './page-refresh.service';
import PageWriter, { type WriterInput } from './page-writer';

/**
 * Refreshing generated pages, over an in-memory store that answers the
 * queries the service makes. No model and no index is ever reached: the
 * writer answers from a script, and the index from the store.
 */

const WORKSPACE = '0b7b1d0e-5c55-4a9e-9d0e-6f4a8c1b2a01';
const OTHER_WORKSPACE = '5d1e0c2b-7a44-4b8e-8c3f-2e9d7a6b5c02';
const PAGE = '9f2c4a1b-3d5e-4f60-8a7b-1c2d3e4f5a03';
const SOURCE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c04';
const MODULE = 'c4d5e6f7-a8b9-4c0d-9e1f-2a3b4c5d6e05';
const OTHER_MODULE = 'd5e6f7a8-b9c0-4d1e-8f2a-3b4c5d6e7f06';
const USER = 'user-1';

const HOUR = 60 * 60 * 1000;
const T0 = new Date('2026-09-01T00:00:00Z');
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

interface PageRow {
  id: string;
  workspaceId: string;
  title: string;
  kind: PageKindEnum;
  question: string | null;
  description: string | null;
  sections: unknown;
  citedEntryIds: string[];
  watermark: Date | null;
  evidenceHash: string | null;
  refreshedAt: Date | null;
  updatedAt: Date;
  deleted: Date | null;
  preferences: unknown;
  updatedById?: string;
}

interface EntryRow {
  id: string;
  pageId: string;
  moduleIds: string[];
  status: string;
  kind: string;
  content: string;
  deleted: Date | null;
  updatedAt: Date;
}

interface LinkRow {
  pageId: string;
  entityType: PageLinkType;
  entityId: string;
  deleted: Date | null;
  updatedAt: Date;
}

interface HistoryRow {
  id: string;
  pageId: string;
  userId: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  changes: Record<string, any>;
  previousBody: string | null;
  previousSections?: unknown;
  deleted: null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Where = Record<string, any>;

function entry(
  id: string,
  content: string,
  overrides: Partial<EntryRow> = {},
): EntryRow {
  return {
    id,
    pageId: SOURCE,
    moduleIds: [MODULE],
    status: 'STANDING',
    kind: 'FACT',
    content,
    deleted: null,
    updatedAt: at(0),
    ...overrides,
  };
}

/** The store, and the fakes built over it. */
function setup(
  options: {
    entries?: EntryRow[];
    links?: LinkRow[];
    page?: Partial<PageRow>;
    configured?: boolean;
  } = {},
) {
  const pages: PageRow[] = [
    {
      id: PAGE,
      workspaceId: WORKSPACE,
      title: 'Deploying',
      kind: PageKindEnum.GENERATED,
      question: 'How do we deploy the server?',
      description: null,
      sections: [],
      citedEntryIds: [],
      watermark: null,
      evidenceHash: null,
      refreshedAt: null,
      updatedAt: at(-24),
      deleted: null,
      preferences: null,
      ...options.page,
    },
    {
      id: SOURCE,
      workspaceId: WORKSPACE,
      title: 'Server notes',
      kind: PageKindEnum.AUTHORED,
      question: null,
      description: null,
      sections: null,
      citedEntryIds: [],
      watermark: null,
      evidenceHash: null,
      refreshedAt: null,
      updatedAt: at(-24),
      deleted: null,
      preferences: null,
    },
  ];
  const entries: EntryRow[] = options.entries ?? [
    entry('e-deploy', 'Deploys go out from main on merge.'),
    entry('e-rollback', 'Revert the merge commit to roll back.'),
  ];
  const links: LinkRow[] = options.links ?? [
    {
      pageId: PAGE,
      entityType: PageLinkType.MODULE,
      entityId: MODULE,
      deleted: null,
      updatedAt: at(-24),
    },
  ];
  const history: HistoryRow[] = [];
  let clock = T0.getTime();
  const tick = () => new Date((clock += 1));

  const pageOf = (id: string) => pages.find((page) => page.id === id);
  const matchesEntry = (row: EntryRow, where: Where): boolean => {
    const page = pageOf(row.pageId);

    return (
      (!where.id?.in || where.id.in.includes(row.id)) &&
      (!('deleted' in where) || row.deleted === null) &&
      (!where.status?.in || where.status.in.includes(row.status)) &&
      // An entry carries its page's workspace, as a row in postgres does.
      (!where.workspaceId || page?.workspaceId === where.workspaceId) &&
      // The live-page filter: on a page not deleted, or on no page.
      (!where.AND || page?.deleted === null) &&
      (!where.OR ||
        where.OR.some((clause: Where) =>
          clause.pageId
            ? row.pageId === clause.pageId
            : row.moduleIds.some((id) => clause.moduleIds.hasSome.includes(id)),
        ))
    );
  };
  const matchesLink = (row: LinkRow, where: Where) =>
    row.pageId === where.pageId &&
    (!('deleted' in where) || row.deleted === null) &&
    (!where.entityType?.in || where.entityType.in.includes(row.entityType));
  const latest = (rows: Array<{ updatedAt: Date }>) =>
    rows.length
      ? new Date(Math.max(...rows.map((row) => row.updatedAt.getTime())))
      : null;
  const pick = <T extends object>(row: T, select?: Where) =>
    select
      ? Object.fromEntries(
          Object.keys(select).map((key) => [
            key,
            key === 'workspace'
              ? { preferences: (row as unknown as PageRow).preferences }
              : (row as Where)[key],
          ]),
        )
      : { ...row };

  const pageApi = {
    findFirst: jest.fn(async ({ where, select }: Where) => {
      const page = pages.find(
        (row) =>
          (!where.id || row.id === where.id) &&
          (!where.workspaceId || row.workspaceId === where.workspaceId) &&
          (!('deleted' in where) || row.deleted === null),
      );

      return page ? pick(page, select) : null;
    }),
    findMany: jest.fn(async ({ where }: Where) =>
      pages
        .filter((row) => row.kind === where.kind && row.deleted === null)
        .map((row) => ({ id: row.id })),
    ),
    create: jest.fn(async ({ data }: Where) => {
      const page: PageRow = {
        id: `page-${pages.length}`,
        workspaceId: data.workspaceId,
        title: data.title,
        kind: data.kind ?? PageKindEnum.AUTHORED,
        question: data.question ?? null,
        description: data.description ?? null,
        sections: data.sections ?? null,
        citedEntryIds: [],
        watermark: null,
        evidenceHash: null,
        refreshedAt: null,
        updatedAt: tick(),
        deleted: null,
        preferences: null,
      };
      pages.push(page);

      return { ...page };
    }),
    update: jest.fn(async ({ where, data }: Where) => {
      const page = pageOf(where.id) as PageRow;
      Object.assign(page, data, { updatedAt: tick() });

      return { ...page };
    }),
    updateMany: jest.fn(async ({ where, data }: Where) => {
      const page = pages.find(
        (row) =>
          row.id === where.id &&
          row.kind === where.kind &&
          row.deleted === null &&
          row.updatedAt.getTime() === where.updatedAt.getTime(),
      );

      if (page) {
        Object.assign(page, data, { updatedAt: tick() });
      }

      return { count: page ? 1 : 0 };
    }),
  };
  const historyApi = {
    create: jest.fn(async ({ data }: Where) => {
      const row: HistoryRow = {
        id: `history-${history.length + 1}`,
        deleted: null,
        ...data,
      } as HistoryRow;
      history.push(structuredClone(row));

      return row;
    }),
    findFirst: jest.fn(async ({ where }: Where) => {
      const row = history.find(
        (candidate) =>
          candidate.id === where.id && candidate.pageId === where.pageId,
      );

      return row
        ? {
            previousBody: row.previousBody,
            previousSections: row.previousSections ?? null,
          }
        : null;
    }),
  };
  const prisma = {
    page: pageApi,
    pageHistory: historyApi,
    pageEntry: {
      aggregate: jest.fn(async ({ where }: Where) => ({
        _max: {
          updatedAt: latest(entries.filter((row) => matchesEntry(row, where))),
        },
      })),
      findMany: jest.fn(async ({ where, select }: Where) =>
        entries
          .filter((row) => matchesEntry(row, where))
          .map((row) => pick(row, select)),
      ),
      updateMany: jest.fn(async (): Promise<{ count: number }> => ({
        count: 0,
      })),
    },
    pageLink: {
      aggregate: jest.fn(async ({ where }: Where) => ({
        _max: {
          updatedAt: latest(links.filter((row) => matchesLink(row, where))),
        },
      })),
      findMany: jest.fn(async ({ where, select }: Where) =>
        links
          .filter((row) => matchesLink(row, where))
          .map((row) => pick(row, select)),
      ),
    },
    capability: { findMany: jest.fn(async (): Promise<never[]> => []) },
    module: {
      findMany: jest.fn(async ({ where }: Where) =>
        where.workspaceId === WORKSPACE
          ? [MODULE, OTHER_MODULE]
              .filter((id) =>
                where.OR.some((clause: Where) => clause.id?.in?.includes(id)),
              )
              .map((id) => ({ id }))
          : [],
      ),
    },
    $transaction: jest.fn(
      async (
        run: ((tx: unknown) => Promise<unknown>) | Array<Promise<unknown>>,
      ): Promise<unknown> =>
        Array.isArray(run)
          ? Promise.all(run)
          : run({ page: pageApi, pageHistory: historyApi }),
    ),
  };

  // The search returns in-use entries and limits each page to three hits.
  const searchKnowledge = jest.fn(
    async (workspaceId: string, _query: string, filter: Where) => {
      const perPage = new Map<string, number>();

      return {
        hits: entries
          .filter(
            (row) =>
              pageOf(row.pageId)?.workspaceId === workspaceId &&
              row.deleted === null &&
              filter.includeStatuses.includes(row.status) &&
              (filter.pageId
                ? row.pageId === filter.pageId
                : row.moduleIds.some((id) => filter.moduleIds.includes(id))),
          )
          .filter((row) => {
            const seen = perPage.get(row.pageId) ?? 0;
            perPage.set(row.pageId, seen + 1);

            return filter.ungrouped || seen < 3;
          })
          .slice(0, filter.limit)
          .map((row) => ({ entryId: row.id, trust: 'GROUNDED' })),
      };
    },
  );
  const vectorService = { searchKnowledge } as unknown as VectorService;

  // The writer is the real one over a scripted completion: it answers
  // whatever the test scripts next, from what it was shown.
  let answer: (input: WriterInput) => string = () =>
    JSON.stringify({ operations: [] });
  const run = jest.fn(async () => ({
    text: answer(operations.mock.calls[operations.mock.calls.length - 1][0]),
    model: 'scripted',
  }));
  const writer = PageWriter.using(run, {
    configured: () => options.configured ?? true,
  });
  const operations = jest.spyOn(writer, 'operations');

  const service = new PageRefreshService(
    prisma as unknown as PrismaService,
    vectorService,
    writer,
  );
  const queue = {
    add: jest.fn<Promise<unknown>, unknown[]>(async () => ({})),
  };
  const pagesService = new PagesService(
    prisma as unknown as PrismaService,
    undefined,
    queue as unknown as Queue,
  );

  return {
    service,
    pagesService,
    queue,
    prisma,
    pages,
    entries,
    links,
    history,
    page: () => pageOf(PAGE) as PageRow,
    searchKnowledge,
    run,
    /** What the writer was shown, call by call. */
    get shown(): WriterInput[] {
      return operations.mock.calls.map(([input]) => input);
    },
    script: (next: (input: WriterInput) => unknown) => {
      answer = (input) => {
        const value = next(input);

        return typeof value === 'string' ? value : JSON.stringify(value);
      };
    },
    /** Nothing was written: no page update, no history row. */
    expectNothingWritten: () => {
      expect(pageApi.updateMany).not.toHaveBeenCalled();
      expect(pageApi.update).not.toHaveBeenCalled();
      expect(historyApi.create).not.toHaveBeenCalled();
    },
  };
}

/** A first build, with one section per entry the writer is shown. */
function sectionPerEntry(input: WriterInput) {
  return {
    operations: input.evidence.map((item, index) => ({
      op: 'insert_section',
      after: null as string | null,
      heading: `Section ${input.evidence.length - index}`,
      body: item.content,
      entryIds: [item.id],
    })),
  };
}

const sectionsOf = (page: PageRow) => page.sections as PageSection[];
const bodyOf = (description: string | null) =>
  convertTiptapJsonToMarkdown(description ?? '').trim();

describe('refreshing a generated page', () => {
  describe('the gate', () => {
    it('[KG-7.2] builds a new page from the entries in its scope', async () => {
      const store = setup();
      store.script(sectionPerEntry);

      await expect(store.service.refresh(PAGE, at(1), {})).resolves.toEqual({
        outcome: 'written',
        applied: 2,
        dropped: 0,
      });

      const page = store.page();
      expect(sectionsOf(page).map((section) => section.entryIds)).toEqual([
        ['e-rollback'],
        ['e-deploy'],
      ]);
      expect(page.citedEntryIds).toEqual(['e-rollback', 'e-deploy']);
      expect(page.refreshedAt).toEqual(at(1));
      // The watermark is the latest change among the entries and links read.
      expect(page.watermark).toEqual(at(0));
      expect(page.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
      expect(store.shown[0].question).toBe('How do we deploy the server?');
    });

    it('[KG-7.2] calls and writes nothing before the minimum interval has passed', async () => {
      const store = setup({
        page: { refreshedAt: at(-5), watermark: at(-10) },
      });
      store.script(sectionPerEntry);

      await expect(store.service.refresh(PAGE, at(0), {})).resolves.toEqual({
        outcome: 'too-soon',
      });

      // Not even the evidence is read: the interval costs nothing to check.
      expect(store.prisma.pageEntry.aggregate).not.toHaveBeenCalled();
      expect(store.searchKnowledge).not.toHaveBeenCalled();
      expect(store.run).not.toHaveBeenCalled();
      store.expectNothingWritten();

      // The same page, an hour later, is due: six hours have passed.
      await expect(store.service.refresh(PAGE, at(1), {})).resolves.toEqual(
        expect.objectContaining({ outcome: 'written' }),
      );
    });

    it('[KG-7.2] calls and writes nothing when no entry in its scope changed since the watermark', async () => {
      const store = setup({
        page: { refreshedAt: at(-24), watermark: at(0) },
      });
      store.script(sectionPerEntry);

      await expect(store.service.refresh(PAGE, at(12), {})).resolves.toEqual({
        outcome: 'unchanged',
      });

      expect(store.searchKnowledge).not.toHaveBeenCalled();
      expect(store.run).not.toHaveBeenCalled();
      store.expectNothingWritten();
    });

    it('[KG-7.2] calls and writes nothing when an entry was only served, which moves its updatedAt', async () => {
      const store = setup();
      store.script(sectionPerEntry);
      await store.service.refresh(PAGE, at(1), {});
      store.prisma.page.updateMany.mockClear();
      store.prisma.pageHistory.create.mockClear();
      store.searchKnowledge.mockClear();
      store.run.mockClear();
      const before = structuredClone(store.page());

      // Serving an entry stamps it, and the stamp moves `updatedAt`; what the
      // entry says, its status and kind are as they were.
      store.entries[0].updatedAt = at(5);

      await expect(store.service.refresh(PAGE, at(12), {})).resolves.toEqual({
        outcome: 'unchanged',
      });
      expect(store.run).not.toHaveBeenCalled();
      expect(store.searchKnowledge).not.toHaveBeenCalled();
      store.expectNothingWritten();
      expect(store.page()).toEqual(before);
    });

    it('[KG-7.2] refreshes once an entry in its scope says something new and the interval has passed', async () => {
      const store = setup();
      store.script(sectionPerEntry);
      await store.service.refresh(PAGE, at(1), {});

      store.entries[0].content = 'Deploys go out from main, behind a canary.';
      store.entries[0].updatedAt = at(2);

      // Changed, but too soon after the last build.
      await expect(store.service.refresh(PAGE, at(3), {})).resolves.toEqual({
        outcome: 'too-soon',
      });
      expect(store.run).toHaveBeenCalledTimes(1);

      const deploy = sectionsOf(store.page()).find(
        (section) => section.entryIds[0] === 'e-deploy',
      ) as PageSection;
      store.script(() => ({
        operations: [
          {
            op: 'replace_section',
            id: deploy.id,
            heading: 'Deploying',
            body: 'Deploys go out from main, behind a canary.',
            entryIds: ['e-deploy'],
          },
        ],
      }));

      await expect(store.service.refresh(PAGE, at(7), {})).resolves.toEqual({
        outcome: 'written',
        applied: 1,
        dropped: 0,
      });
      expect(store.run).toHaveBeenCalledTimes(2);
      expect(store.page().watermark).toEqual(at(2));
      expect(store.page().refreshedAt).toEqual(at(7));
      // The writer is shown the page as it stands, and why it is rebuilt.
      expect(store.shown[1].sections).toHaveLength(2);
      expect(store.shown[1].evidence.map((item) => item.content)).toContain(
        'Deploys go out from main, behind a canary.',
      );
    });

    it('[KG-7.2] reads the minimum interval from the workspace, then the deployment', async () => {
      const due = async (preferences: unknown, env: NodeJS.ProcessEnv) => {
        const store = setup({
          page: { refreshedAt: at(-2), watermark: at(-10), preferences },
        });
        store.script(sectionPerEntry);

        return (await store.service.refresh(PAGE, at(0), env)).outcome;
      };

      // Two hours since the last build: short of six, past one.
      expect(await due(null, {})).toBe('too-soon');
      expect(
        await due(null, { KNOWLEDGE_PAGE_REFRESH_MIN_INTERVAL: '1h' }),
      ).toBe('written');
      expect(
        await due(
          { knowledge: { pageRefreshMinInterval: '90m' } },
          { KNOWLEDGE_PAGE_REFRESH_MIN_INTERVAL: '12h' },
        ),
      ).toBe('written');
      expect(
        await due(
          { knowledge: { pageRefreshMinInterval: '3h' } },
          { KNOWLEDGE_PAGE_REFRESH_MIN_INTERVAL: '1h' },
        ),
      ).toBe('too-soon');
    });

    it('[KG-7.2] counts an entry leaving use as a change, though it says the same', async () => {
      const store = setup({
        entries: [
          entry('e-deploy', 'Deploys go out from main on merge.'),
          entry('e-rollback', 'Revert the merge commit to roll back.'),
          entry('e-setup', 'Run pnpm install, then pnpm dev.'),
        ],
      });
      store.script(sectionPerEntry);
      await store.service.refresh(PAGE, at(1), {});
      const [setupSection, rollback, deploy] = sectionsOf(store.page());

      store.entries[1].status = 'ARCHIVED';
      store.entries[1].updatedAt = at(2);
      store.script(() => ({ operations: [] }));

      await expect(store.service.refresh(PAGE, at(8), {})).resolves.toEqual({
        outcome: 'written',
        applied: 1,
        dropped: 0,
      });
      // The section resting on it is gone; the writer was still asked.
      expect(store.run).toHaveBeenCalledTimes(2);
      expect(sectionsOf(store.page())).toEqual([setupSection, deploy]);
      expect(sectionsOf(store.page())).not.toContainEqual(rollback);

      // So is an entry deleted, with its status as it was.
      store.entries[0].deleted = at(9);
      store.entries[0].updatedAt = at(9);
      await expect(store.service.refresh(PAGE, at(16), {})).resolves.toEqual({
        outcome: 'written',
        applied: 1,
        dropped: 0,
      });
      expect(sectionsOf(store.page())).toEqual([setupSection]);

      // With nothing in scope left to read, the retrieval is empty, and an
      // empty retrieval writes nothing: not even what code would remove.
      store.entries[2].status = 'SUPERSEDED';
      store.entries[2].updatedAt = at(17);
      store.prisma.page.updateMany.mockClear();
      store.prisma.pageHistory.create.mockClear();
      await expect(store.service.refresh(PAGE, at(24), {})).resolves.toEqual({
        outcome: 'no-evidence',
      });
      store.expectNothingWritten();
      expect(sectionsOf(store.page())).toEqual([setupSection]);
    });

    it('[KG-7.2] watches the entries of the modules its links name, and the links', async () => {
      const store = setup({
        entries: [
          entry('e-deploy', 'Deploys go out from main on merge.'),
          entry('e-elsewhere', 'The webapp builds with vite.', {
            moduleIds: [OTHER_MODULE],
            updatedAt: at(0),
          }),
        ],
      });
      store.script(sectionPerEntry);
      await store.service.refresh(PAGE, at(1), {});
      expect(store.page().citedEntryIds).toEqual(['e-deploy']);

      // A change outside its modules is not a change to its evidence.
      store.entries[1].content = 'The webapp builds with vite 7.';
      store.entries[1].updatedAt = at(3);
      await expect(store.service.refresh(PAGE, at(12), {})).resolves.toEqual({
        outcome: 'unchanged',
      });
      expect(store.run).toHaveBeenCalledTimes(1);

      // Linking the page to that module is.
      store.links.push({
        pageId: PAGE,
        entityType: PageLinkType.MODULE,
        entityId: OTHER_MODULE,
        deleted: null,
        updatedAt: at(13),
      });
      store.script(() => ({ operations: [] }));
      await expect(store.service.refresh(PAGE, at(14), {})).resolves.toEqual({
        outcome: 'no-change',
        dropped: 0,
      });
      expect(store.run).toHaveBeenCalledTimes(2);
      expect(store.shown[1].evidence.map((item) => item.id)).toEqual(
        expect.arrayContaining(['e-deploy', 'e-elsewhere']),
      );
    });

    it('[KG-7.2] counts a link taken away as a change, and drops what it brought', async () => {
      const store = setup({
        entries: [
          entry('e-deploy', 'Deploys go out from main on merge.'),
          entry('e-elsewhere', 'The webapp builds with vite.', {
            moduleIds: [OTHER_MODULE],
          }),
          // An entry on the generated page itself is in its scope too.
          entry('e-own', 'Ask #ops before a Friday deploy.', {
            pageId: PAGE,
            moduleIds: [],
          }),
        ],
        links: [
          {
            pageId: PAGE,
            entityType: PageLinkType.MODULE,
            entityId: MODULE,
            deleted: null,
            updatedAt: at(-24),
          },
          {
            pageId: PAGE,
            entityType: PageLinkType.MODULE,
            entityId: OTHER_MODULE,
            deleted: null,
            updatedAt: at(-24),
          },
        ],
      });
      store.script(sectionPerEntry);
      await store.service.refresh(PAGE, at(1), {});
      expect([...store.page().citedEntryIds].sort()).toEqual([
        'e-deploy',
        'e-elsewhere',
        'e-own',
      ]);

      // No entry changes; the page is unlinked from one module.
      store.links[1].deleted = at(3);
      store.links[1].updatedAt = at(3);
      store.script(() => ({ operations: [] }));

      await expect(store.service.refresh(PAGE, at(8), {})).resolves.toEqual({
        outcome: 'written',
        applied: 1,
        dropped: 0,
      });
      expect([...store.page().citedEntryIds].sort()).toEqual([
        'e-deploy',
        'e-own',
      ]);
      expect(store.shown[1].evidence.map((item) => item.id).sort()).toEqual([
        'e-deploy',
        'e-own',
      ]);
    });

    it('[KG-7.2] [KG-7.3] rebuilds a page asked a new question once the interval has passed, and may rewrite all of it', async () => {
      const store = setup();
      store.script(sectionPerEntry);
      await store.service.refresh(PAGE, at(1), {});
      const before = sectionsOf(store.page());

      const clock = jest.spyOn(Date, 'now').mockReturnValue(at(2).getTime());
      try {
        await store.pagesService.updatePage(PAGE, USER, {
          question: 'How do we roll back a deploy?',
        });
      } finally {
        clock.mockRestore();
      }

      // The build is queued for when the interval since the last one has
      // passed, so it runs whether or not the hourly look does.
      const options = store.queue.add.mock.calls[0][2] as { delay: number };
      expect(options.delay).toBe(5 * HOUR + 1_000);

      // No entry changed. Before then, it is too soon.
      store.script((input) => ({
        operations: input.sections.map((section) => ({
          op: 'replace_section',
          id: section.id,
          heading: `Rolling back: ${section.heading}`,
          body: section.body,
          entryIds: section.entryIds,
        })),
      }));
      await expect(store.service.refresh(PAGE, at(3), {})).resolves.toEqual({
        outcome: 'too-soon',
      });
      expect(store.run).toHaveBeenCalledTimes(1);

      // When the job runs, the page is built for its new question, and every
      // section, written for the old one, is the writer's to rewrite.
      await expect(
        store.service.refresh(
          PAGE,
          new Date(at(2).getTime() + options.delay),
          {},
        ),
      ).resolves.toEqual({ outcome: 'written', applied: 2, dropped: 0 });
      expect(store.shown[1].question).toBe('How do we roll back a deploy?');
      expect(store.shown[1].editable).toEqual(
        before.map((section) => section.id),
      );
      expect(
        sectionsOf(store.page()).map((section) => section.heading),
      ).toEqual(before.map((section) => `Rolling back: ${section.heading}`));
    });

    it('[KG-7.2] leaves pages people write alone', async () => {
      const store = setup({ page: { kind: PageKindEnum.AUTHORED } });

      await expect(store.service.refresh(PAGE, at(1), {})).resolves.toEqual({
        outcome: 'not-generated',
      });
      expect(store.prisma.pageEntry.aggregate).not.toHaveBeenCalled();
      store.expectNothingWritten();
    });

    it('[KG-7.2] looks at every generated page, and one failing stops no other', async () => {
      const store = setup();
      store.script(sectionPerEntry);
      store.pages.push({
        ...store.page(),
        id: 'page-other',
        title: 'Rolling back',
      });
      store.links.push({ ...store.links[0], pageId: 'page-other' });
      store.prisma.page.findFirst.mockImplementationOnce(async () => {
        throw new Error('connection reset');
      });

      await expect(store.service.refreshDue(at(1), {})).resolves.toEqual({
        checked: 2,
        written: 1,
      });
    });
  });

  describe('the edits', () => {
    const built = async () => {
      const store = setup({
        entries: [
          entry('e-setup', 'Run pnpm install, then pnpm dev.'),
          entry('e-deploy', 'Deploys go out from main on merge.'),
          entry('e-rollback', 'Revert the merge commit to roll back.'),
        ],
      });
      store.script(sectionPerEntry);
      await store.service.refresh(PAGE, at(1), {});
      store.entries[1].content = 'Deploys go out from main, behind a canary.';
      store.entries[1].updatedAt = at(2);
      store.prisma.page.updateMany.mockClear();
      store.prisma.pageHistory.create.mockClear();

      return store;
    };

    it('[KG-7.3] stores every section no operation names byte for byte', async () => {
      const store = await built();
      const before = sectionsOf(store.page());
      const [first, second, third] = before;
      store.script(() => ({
        operations: [
          {
            op: 'replace_section',
            id: second.id,
            heading: 'Deploying',
            body: 'Deploys go out from main, behind a canary.',
            entryIds: ['e-deploy'],
          },
        ],
      }));

      await store.service.refresh(PAGE, at(8), {});

      const after = sectionsOf(store.page());
      expect(after.map((section) => section.id)).toEqual(
        before.map((section) => section.id),
      );
      expect(JSON.stringify(after[0])).toBe(JSON.stringify(first));
      expect(JSON.stringify(after[2])).toBe(JSON.stringify(third));
      expect(after[1].body).toBe('Deploys go out from main, behind a canary.');
      expect(bodyOf(store.page().description)).toContain(first.body);
    });

    it('[KG-7.3] drops an operation naming a section the page does not have, and records it', async () => {
      const store = await built();
      const before = sectionsOf(store.page());
      store.script(() => ({
        operations: [
          { op: 'remove_section', id: 'sec_never_existed' },
          {
            op: 'replace_section',
            id: 'sec_invented',
            heading: 'Rewritten',
            body: 'All new.',
            entryIds: ['e-deploy'],
          },
          // The section on the entry that changed, which it may remove.
          { op: 'remove_section', id: before[1].id },
        ],
      }));

      await expect(store.service.refresh(PAGE, at(8), {})).resolves.toEqual({
        outcome: 'written',
        applied: 1,
        dropped: 2,
      });
      expect(sectionsOf(store.page())).toEqual([before[0], before[2]]);
      expect(store.history[store.history.length - 1].changes).toEqual({
        body: true,
        refreshed: { operations: 1, dropped: 2 },
      });
    });

    it('[KG-7.3] rewrites or removes only the sections whose evidence changed, whatever the model asks', async () => {
      const store = await built();
      const [rollback, deploy, setupSection] = sectionsOf(store.page());
      // An answer that would collapse the page into one section.
      const collapse = (input: WriterInput) => ({
        operations: [
          ...input.sections.map((section) => ({
            op: 'remove_section',
            id: section.id,
          })),
          {
            op: 'insert_section',
            after: null as string | null,
            heading: 'Deploying',
            body: 'Everything, in one section.',
            entryIds: input.evidence.map((item) => item.id),
          },
        ],
      });
      store.script(collapse);

      await expect(store.service.refresh(PAGE, at(8), {})).resolves.toEqual({
        outcome: 'written',
        applied: 2,
        dropped: 2,
      });

      // Only the section resting on the entry that changed was its to
      // rewrite, and the writer was told so.
      expect(store.shown[1].editable).toEqual([deploy.id]);
      const after = sectionsOf(store.page());
      expect(after.map((section) => section.id)).toEqual([
        expect.stringMatching(/^sec_/),
        rollback.id,
        setupSection.id,
      ]);
      expect(after[0]).toMatchObject({
        body: 'Everything, in one section.',
        entryIds: ['e-setup', 'e-deploy', 'e-rollback'],
      });
      expect(JSON.stringify(after[1])).toBe(JSON.stringify(rollback));
      expect(JSON.stringify(after[2])).toBe(JSON.stringify(setupSection));

      // What it wrote records what it was written from: a new entry no
      // section cites changes none of them, so none is its to rewrite.
      store.entries.push(
        entry('e-canary', 'Canaries run for ten minutes.', {
          updatedAt: at(9),
        }),
      );
      store.script(collapse);

      await expect(store.service.refresh(PAGE, at(16), {})).resolves.toEqual({
        outcome: 'written',
        applied: 1,
        dropped: 3,
      });
      expect(store.shown[2].editable).toEqual([]);
      expect(sectionsOf(store.page()).slice(1)).toEqual(after);
    });

    it('[KG-7.3] reads every entry in its scope that the index finds, not three a page', async () => {
      const facts = ['one', 'two', 'three', 'four', 'five'];
      const store = setup({
        entries: facts.map((fact) =>
          entry(`e-${fact}`, `Deploys go out on merge, rule ${fact}.`),
        ),
      });
      store.script(sectionPerEntry);

      await store.service.refresh(PAGE, at(1), {});

      // All five sit on one page, and all five were read and written up.
      expect(store.shown[0].evidence.map((item) => item.id)).toEqual(
        facts.map((fact) => `e-${fact}`),
      );
      expect([...store.page().citedEntryIds].sort()).toEqual(
        facts.map((fact) => `e-${fact}`).sort(),
      );
      for (const [, , filter] of store.searchKnowledge.mock.calls) {
        expect(filter).toMatchObject({ limit: 40, ungrouped: true });
      }
    });

    it('[KG-7.3] writes nothing when the index cannot be reached', async () => {
      const store = await built();
      const before = structuredClone(store.page());
      store.searchKnowledge.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await expect(store.service.refresh(PAGE, at(8), {})).resolves.toEqual({
        outcome: 'retrieval-failed',
      });
      expect(store.run).toHaveBeenCalledTimes(1);
      store.expectNothingWritten();
      // Not even the watermark moves: the next look tries again.
      expect(store.page()).toEqual(before);
    });

    it('[KG-7.3] writes nothing when the retrieval finds nothing it may use', async () => {
      const store = await built();
      const before = structuredClone(store.page());

      // Neither the page's own entries nor its modules' are found.
      store.searchKnowledge
        .mockResolvedValueOnce({ hits: [] } as never)
        .mockResolvedValueOnce({ hits: [] } as never);
      await expect(store.service.refresh(PAGE, at(8), {})).resolves.toEqual({
        outcome: 'no-evidence',
      });

      // Hits the index still holds, for entries postgres says are out of use
      // or in another workspace, are nothing either.
      store.searchKnowledge
        .mockResolvedValueOnce({ hits: [] } as never)
        .mockResolvedValueOnce({
          hits: [{ entryId: 'e-gone' }, { entryId: 'e-theirs' }],
        } as never);
      store.entries.push(
        entry('e-gone', 'Old.', { status: 'ARCHIVED' }),
        entry('e-theirs', 'Theirs.', { pageId: 'page-theirs' }),
      );
      store.pages.push({
        ...store.page(),
        id: 'page-theirs',
        workspaceId: OTHER_WORKSPACE,
      });
      await expect(store.service.refresh(PAGE, at(8), {})).resolves.toEqual({
        outcome: 'no-evidence',
      });

      expect(store.run).toHaveBeenCalledTimes(1);
      store.expectNothingWritten();
      expect(store.page()).toEqual(before);
    });

    it('[KG-7.3] writes nothing when the writer fails or answers with something other than operations', async () => {
      const store = await built();
      const before = structuredClone(store.page());

      store.script(() => {
        throw new Error('rate limited');
      });
      await expect(store.service.refresh(PAGE, at(8), {})).resolves.toEqual({
        outcome: 'writer-failed',
      });

      store.script(() => 'Here is the updated page: ## Deploying ...');
      await expect(store.service.refresh(PAGE, at(8), {})).resolves.toEqual({
        outcome: 'writer-failed',
      });

      store.expectNothingWritten();
      expect(store.page()).toEqual(before);
    });

    it('[KG-7.3] shows the writer the entries its sections rest on, and which are out of use', async () => {
      const store = await built();
      store.entries[2].status = 'ARCHIVED';
      store.entries[2].updatedAt = at(3);
      // The search finds only one of the entries the page cites.
      store.searchKnowledge
        .mockResolvedValueOnce({ hits: [] } as never)
        .mockResolvedValueOnce({
          hits: [{ entryId: 'e-deploy', trust: 'VERIFIED' }],
        } as never);

      await store.service.refresh(PAGE, at(8), {});

      const shown = store.shown[store.shown.length - 1];
      expect(shown.evidence).toEqual([
        {
          id: 'e-deploy',
          kind: 'FACT',
          trust: 'VERIFIED',
          content: 'Deploys go out from main, behind a canary.',
        },
        {
          id: 'e-setup',
          kind: 'FACT',
          trust: null,
          content: 'Run pnpm install, then pnpm dev.',
        },
      ]);
      // A section resting only on an entry out of use was removed in code,
      // before the writer was asked.
      expect(shown.sections.flatMap((section) => section.entryIds)).toEqual([
        'e-deploy',
        'e-setup',
      ]);
      expect(shown.outOfUse).toEqual([]);
    });

    it('[KG-7.3] shows the writer what the index found, in the order it ranked it', async () => {
      const store = await built();
      store.searchKnowledge
        .mockResolvedValueOnce({ hits: [] } as never)
        .mockResolvedValueOnce({
          hits: [
            { entryId: 'e-rollback', trust: 'VERIFIED' },
            { entryId: 'e-setup', trust: 'GROUNDED' },
            { entryId: 'e-deploy', trust: 'CLAIMED' },
          ],
        } as never);

      await store.service.refresh(PAGE, at(8), {});

      expect(
        store.shown[store.shown.length - 1].evidence.map((item) => [
          item.id,
          item.trust,
        ]),
      ).toEqual([
        ['e-rollback', 'VERIFIED'],
        ['e-setup', 'GROUNDED'],
        ['e-deploy', 'CLAIMED'],
      ]);
    });

    it('[KG-7.2] [KG-7.3] writes nothing over a page changed while the writer was asked', async () => {
      for (const meanwhile of [
        // A person takes the page over by hand.
        (page: PageRow) => {
          page.kind = PageKindEnum.AUTHORED;
          page.updatedAt = at(8);
        },
        // A person renames it, or reverts a refresh.
        (page: PageRow) => {
          page.updatedAt = at(8);
        },
      ]) {
        const store = await built();
        const first = sectionsOf(store.page())[0];
        store.script(() => {
          meanwhile(store.page());

          return { operations: [{ op: 'remove_section', id: first.id }] };
        });

        await expect(store.service.refresh(PAGE, at(8), {})).resolves.toEqual({
          outcome: 'raced',
        });
        expect(store.prisma.pageHistory.create).not.toHaveBeenCalled();
        expect(sectionsOf(store.page())[0]).toEqual(first);
      }
    });

    it('[KG-7.3] removes, without a model, a section whose every entry has gone out of use, and nothing else', async () => {
      const store = await built();
      const before = sectionsOf(store.page());
      const run = store.run;
      const noModel = setup({ configured: false });
      // The same page and entries, with no model configured.
      Object.assign(noModel.page(), structuredClone(store.page()));
      noModel.entries.splice(
        0,
        noModel.entries.length,
        ...structuredClone(store.entries),
      );
      noModel.entries[2].status = 'SUPERSEDED';
      noModel.entries[2].updatedAt = at(3);
      const watermark = noModel.page().watermark;

      await expect(
        noModel.service.refresh(PAGE, at(8), {}),
      ).resolves.toMatchObject({ outcome: 'written', applied: 1 });

      expect(noModel.run).not.toHaveBeenCalled();
      expect(noModel.searchKnowledge).not.toHaveBeenCalled();
      expect(sectionsOf(noModel.page())).toEqual(before.slice(1));
      expect(noModel.page().citedEntryIds).toEqual(['e-deploy', 'e-setup']);
      // The new evidence waits for a model: the watermark is where it was.
      expect(noModel.page().watermark).toEqual(watermark);

      // With nothing left to remove, nothing is written.
      noModel.prisma.page.updateMany.mockClear();
      noModel.prisma.pageHistory.create.mockClear();
      await expect(noModel.service.refresh(PAGE, at(20), {})).resolves.toEqual({
        outcome: 'no-change',
      });
      noModel.expectNothingWritten();
      expect(run).toHaveBeenCalledTimes(1);
    });
  });

  describe('the history', () => {
    it('[KG-7.5] records every refresh with the body and the sections it replaced', async () => {
      const store = setup();
      store.script(sectionPerEntry);

      await store.service.refresh(PAGE, at(1), {});
      const first = structuredClone(store.page());
      store.entries[0].content = 'Deploys go out from main, behind a canary.';
      store.entries[0].updatedAt = at(2);
      store.script(() => ({
        operations: [
          { op: 'remove_section', id: sectionsOf(first)[1].id },
          { op: 'remove_section', id: 'sec_unknown' },
        ],
      }));
      await store.service.refresh(PAGE, at(8), {});
      store.entries[1].content = 'Revert the merge commit, then redeploy.';
      store.entries[1].updatedAt = at(9);
      store.script(() => ({ operations: [] }));
      await store.service.refresh(PAGE, at(16), {});

      expect(store.history).toHaveLength(3);
      // The first build replaced an empty page.
      expect(store.history[0]).toMatchObject({
        pageId: PAGE,
        userId: null,
        changes: { body: true, refreshed: { operations: 2, dropped: 0 } },
        previousSections: [],
      });
      expect(bodyOf(store.history[0].previousBody)).toBe('');
      expect(store.history[1]).toMatchObject({
        changes: { body: true, refreshed: { operations: 1, dropped: 1 } },
        previousBody: first.description,
        previousSections: first.sections,
      });
      // A refresh that changed nothing is recorded too, with what it dropped
      // and the body it left as it was.
      expect(store.history[2]).toMatchObject({
        changes: { refreshed: { operations: 0, dropped: 0 } },
        previousBody: store.page().description,
        previousSections: store.page().sections,
      });
      expect(store.history[2].changes.body).toBeUndefined();
    });

    it('[KG-7.5] reverts a refresh with the existing revert: the body, the sections and what the page cites', async () => {
      const store = setup();
      store.script(sectionPerEntry);
      await store.service.refresh(PAGE, at(1), {});
      const first = structuredClone(store.page());

      store.entries[0].content = 'Deploys go out from main, behind a canary.';
      store.entries[0].updatedAt = at(2);
      store.entries[1].content = 'Revert the merge commit, then redeploy.';
      store.entries[1].updatedAt = at(2);
      store.script(() => ({
        operations: [
          {
            op: 'replace_section',
            id: sectionsOf(first)[1].id,
            heading: 'Deploying',
            body: 'Deploys go out behind a canary.',
            entryIds: ['e-deploy'],
          },
          { op: 'remove_section', id: sectionsOf(first)[0].id },
        ],
      }));
      await store.service.refresh(PAGE, at(8), {});
      const refreshed = structuredClone(store.page());
      expect(refreshed.citedEntryIds).toEqual(['e-deploy']);
      const row = store.history[store.history.length - 1];

      const reverted = await store.pagesService.revertBody(PAGE, row.id, USER);

      expect(store.page().description).toBe(first.description);
      expect(store.page().sections).toEqual(first.sections);
      expect(store.page().citedEntryIds).toEqual(first.citedEntryIds);
      expect(reverted.descriptionMarkdown).toContain(
        'Revert the merge commit to roll back.',
      );
      // The revert is itself recorded, and can be undone in turn.
      const undo = store.history[store.history.length - 1];
      expect(undo).toMatchObject({
        userId: USER,
        changes: { body: true, revertedTo: { to: row.id } },
        previousBody: refreshed.description,
        previousSections: refreshed.sections,
      });

      await store.pagesService.revertBody(PAGE, undo.id, USER);
      expect(store.page().sections).toEqual(refreshed.sections);
      expect(store.page().citedEntryIds).toEqual(['e-deploy']);
    });

    it('[KG-7.5] keeps a revert until the evidence changes again', async () => {
      const store = setup();
      store.script(sectionPerEntry);
      await store.service.refresh(PAGE, at(1), {});
      const row = store.history[0];

      await store.pagesService.revertBody(PAGE, row.id, USER);
      expect(sectionsOf(store.page())).toEqual([]);

      await expect(store.service.refresh(PAGE, at(12), {})).resolves.toEqual({
        outcome: 'unchanged',
      });
      expect(store.run).toHaveBeenCalledTimes(1);
    });
  });
});

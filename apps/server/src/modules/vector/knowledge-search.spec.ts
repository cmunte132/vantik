/**
 * Knowledge retrieval, from the documents the index is given to the order a
 * search returns them in.
 *
 * Typesense does the filtering and ranking, and there is none here. So the
 * documents are built by the real `indexPage` and `indexEntry`, the search
 * request by the real `searchKnowledge`, and a small evaluator below applies
 * that request's `filter_by`, `sort_by` and grouping to those documents. It
 * understands the subset of the filter language the service writes — `field:=`
 * a value or a list, `field:true`, `&&`, `||` and parentheses — and scores
 * `_eval` the way Typesense does, by the best tier a document matches. What it
 * proves is that the documents and the request agree with each other about
 * what should come back.
 */
import { PageEntryKindEnum, PageEntryStatusEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';
import { Client as TypesenseClient } from 'typesense';

import { pageSchema } from './vector.interface';
import { VectorService } from './vector.service';

type Doc = Record<string, unknown>;
type Predicate = (doc: Doc) => boolean;

const WORKSPACE = '00000000-0000-0000-0000-000000000001';

// ------------------------------------------------------------ the evaluator

/** Parses the filter subset the service writes into a predicate. */
function parseFilter(expression: string): Predicate {
  let at = 0;
  const skip = () => {
    while (expression[at] === ' ') {
      at++;
    }
  };
  const take = (token: string) => {
    skip();
    if (expression.startsWith(token, at)) {
      at += token.length;
      return true;
    }
    return false;
  };
  const scalar = (): string => {
    skip();
    if (expression[at] === '`') {
      const end = expression.indexOf('`', at + 1);
      const value = expression.slice(at + 1, end);
      at = end + 1;
      return value;
    }
    const match = /^[\w.-]+/.exec(expression.slice(at));
    if (!match) {
      throw new Error(`Unreadable value at ${at}: ${expression}`);
    }
    at += match[0].length;
    return match[0];
  };
  const values = (): string[] => {
    if (!take('[')) {
      return [scalar()];
    }
    const list = [scalar()];
    while (take(',')) {
      list.push(scalar());
    }
    if (!take(']')) {
      throw new Error(`Unclosed list: ${expression}`);
    }
    return list;
  };
  const atom = (): Predicate => {
    if (take('(')) {
      const inner = or();
      if (!take(')')) {
        throw new Error(`Unclosed group: ${expression}`);
      }
      return inner;
    }
    skip();
    const field = /^\w+/.exec(expression.slice(at))?.[0];
    if (!field) {
      throw new Error(`No field at ${at}: ${expression}`);
    }
    at += field.length;
    if (!take(':')) {
      throw new Error(`No colon after ${field}`);
    }
    take('=');
    const wanted = values();
    return (doc) => {
      const actual = doc[field];
      const held = Array.isArray(actual) ? actual : [actual];
      return held.some((value) => wanted.includes(String(value)));
    };
  };
  const and = (): Predicate => {
    const parts = [atom()];
    while (take('&&')) {
      parts.push(atom());
    }
    return (doc) => parts.every((part) => part(doc));
  };
  const or = (): Predicate => {
    const parts = [and()];
    while (take('||')) {
      parts.push(and());
    }
    return (doc) => parts.some((part) => part(doc));
  };

  const predicate = or();
  skip();
  if (at !== expression.length) {
    throw new Error(`Trailing input: ${expression}`);
  }
  return predicate;
}

/** Splits on commas that are not inside brackets or parentheses. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if ('([{'.includes(text[i])) {
      depth++;
    }
    if (')]}'.includes(text[i])) {
      depth--;
    }
    if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim());
}

/** One sort key: a function from document to a number, descending. */
function sortKey(key: string, query: string): (doc: Doc) => number {
  if (key.startsWith('_eval(')) {
    const tiers = splitTop(
      key.slice('_eval(['.length, key.lastIndexOf('])')),
    ).map((tier) => {
      const colon = tier.lastIndexOf('):');
      return {
        matches: parseFilter(tier.slice(1, colon)),
        score: Number(tier.slice(colon + 2)),
      };
    });
    // The best tier a document matches, as Typesense scores it.
    return (doc) =>
      Math.max(0, ...tiers.filter((t) => t.matches(doc)).map((t) => t.score));
  }
  if (key.startsWith('_text_match')) {
    const words = query === '*' ? [] : query.toLowerCase().split(/\s+/);
    return (doc) => {
      const text = `${doc.title} ${doc.content}`.toLowerCase();
      return words.reduce(
        (score, word) => score + text.split(word).length - 1,
        0,
      );
    };
  }
  const field = key.split(':')[0];
  return (doc) => Number(doc[field] ?? 0);
}

/**
 * A stand-in for the pages collection, holding what was upserted. `entries`
 * is what postgres holds for an entry beyond its id: its status,
 * verification and citations, which the proof is read from.
 */
function fakeIndex(
  entries: Record<string, Doc> = {},
  citing: Array<{
    id: string;
    title: string;
    citedEntryIds: string[];
    deleted?: Date | null;
    workspaceId?: string;
  }> = [],
) {
  const docs = new Map<string, Doc>();
  const searches: Array<Record<string, unknown>> = [];

  const typesense = {
    collections: () => ({
      documents: () => ({
        upsert: async (doc: Doc) => {
          docs.set(doc.id as string, doc);
          return doc;
        },
      }),
    }),
    multiSearch: {
      perform: async ({
        searches: [search],
      }: {
        searches: Array<Record<string, string | number>>;
      }) => {
        searches.push(search);
        const matches = parseFilter(search.filter_by as string);
        const sortBy = splitTop(search.sort_by as string);
        const keys = sortBy.map((key) => sortKey(key, search.q as string));
        const order = (a: Doc, b: Doc) => {
          for (const key of keys) {
            const difference = key(b) - key(a);
            if (difference !== 0) {
              return difference;
            }
          }
          return 0;
        };
        const ranked = [...docs.values()].filter(matches).sort(order);

        // `_text_match(buckets: N)` as Typesense applies it: rank on the raw
        // score, cut the ranking into blocks of floor(results / N), give every
        // document in a block its first document's score, and rank again. With
        // fewer than N results nothing is bucketed.
        const bucketed = sortBy.findIndex((key) =>
          /^_text_match\(buckets: \d+\)/.test(key),
        );
        const buckets = Number(/buckets: (\d+)/.exec(sortBy[bucketed])?.[1]);
        if (bucketed >= 0 && ranked.length >= buckets) {
          const raw = keys[bucketed];
          const block = Math.floor(ranked.length / buckets);
          const anchored = new Map<Doc, number>();
          ranked.forEach((doc, i) =>
            anchored.set(doc, raw(ranked[i - (i % block)])),
          );
          keys[bucketed] = (doc) => anchored.get(doc) ?? 0;
          ranked.sort(order);
        }

        if (search.group_by === undefined) {
          return {
            results: [
              {
                hits: ranked
                  .slice(0, Number(search.per_page))
                  .map((document) => ({ document })),
                found: ranked.length,
              },
            ],
          };
        }

        const groups = new Map<unknown, Doc[]>();
        for (const doc of ranked) {
          const group = groups.get(doc.pageId) ?? [];
          if (group.length < Number(search.group_limit)) {
            group.push(doc);
          }
          groups.set(doc.pageId, group);
        }

        return {
          results: [
            {
              grouped_hits: [...groups.values()]
                .slice(0, Number(search.per_page))
                .map((group) => ({
                  hits: group.map((document) => ({ document })),
                })),
              found: ranked.length,
            },
          ],
        };
      },
    },
  } as unknown as TypesenseClient;

  // Everything indexed still exists, so the stale-hit filter keeps it all;
  // the pages that cite entries are `citing`.
  const pages = async ({
    where,
  }: {
    where: {
      id?: { in: string[] };
      citedEntryIds?: { hasSome: string[] };
      deleted?: null;
      workspaceId?: string;
    };
  }) =>
    where.citedEntryIds
      ? citing.filter(
          (page) =>
            (page.workspaceId ?? WORKSPACE) === where.workspaceId &&
            (where.deleted !== null || !page.deleted) &&
            page.citedEntryIds.some((id) =>
              where.citedEntryIds?.hasSome.includes(id),
            ),
        )
      : (where.id?.in ?? []).map((id) => ({ id }));
  const prisma = {
    page: { findMany: pages },
    pageEntry: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, ...entries[id] })),
    },
  } as unknown as PrismaService;

  return { service: new VectorService(prisma, typesense), docs, searches };
}

// ------------------------------------------------------------------ fixtures

const moduleId = (n: number) => `00000000-0000-0000-0000-00000000000${n}`;
const SERVER = moduleId(2);
const WEBAPP = moduleId(3);
const TYPES = moduleId(4);

async function seed(service: VectorService) {
  const entry = (
    id: string,
    content: string,
    extra: Partial<{
      scope: string | null;
      moduleIds: string[];
      kind: string;
      verifiedAt: Date | null;
      pageId: string;
    }> = {},
  ) =>
    service.indexEntry({
      id,
      content,
      scope: null,
      status: PageEntryStatusEnum.STANDING,
      sourceUserId: 'agent-1',
      verifiedAt: null,
      retrievalCount: 0,
      updatedAt: new Date('2026-09-01'),
      pageId: extra.pageId ?? `page-${id}`,
      moduleIds: [],
      kind: PageEntryKindEnum.FACT,
      page: { title: 'Server notes', workspaceId: WORKSPACE },
      ...extra,
    });

  await service.indexPage({
    id: 'body',
    title: 'Architecture',
    description: null,
    workspaceId: WORKSPACE,
    updatedAt: new Date('2026-09-01'),
  });
  await entry('server', 'The server owns redis connections.', {
    scope: 'apps/server',
    moduleIds: [SERVER],
  });
  await entry('migrations', 'Migrations are hand-written redis-free SQL.', {
    scope: 'apps/server/prisma/migrations',
    moduleIds: [SERVER],
    kind: PageEntryKindEnum.CONVENTION,
  });
  await entry('webapp', 'The webapp never talks to redis directly.', {
    scope: 'apps/webapp',
    moduleIds: [WEBAPP],
  });
  await entry('globbed', 'Server tests stub redis.', {
    scope: 'apps/server/**/*.spec.ts',
    moduleIds: [SERVER],
    kind: PageEntryKindEnum.GOTCHA,
  });
  await entry('everywhere', 'redis redis redis: it is only ever a cache.', {
    scope: null,
  });
  await entry('types', 'Shared types build to dist before tests.', {
    scope: 'packages/types',
    moduleIds: [TYPES],
    kind: PageEntryKindEnum.DECISION,
  });
}

const ids = (hits: Array<{ entryId: string | null; pageId: string }>) =>
  hits.map((hit) => hit.entryId ?? `page:${hit.pageId}`);

// --------------------------------------------------------------------- tests

describe('knowledge documents', () => {
  it("[KG-1.2] indexes an entry's modules as a facet", async () => {
    const { service, docs } = fakeIndex();
    await seed(service);

    const field = pageSchema.fields.find((f) => f.name === 'moduleIds');
    expect(field).toMatchObject({ type: 'string[]', facet: true });
    expect(docs.get('entry:server')).toMatchObject({ moduleIds: [SERVER] });
    // A page body is about no module in particular.
    expect(docs.get('page:body')).toMatchObject({ moduleIds: [] });
  });
});

describe('scoped retrieval', () => {
  it('[KG-1.3] serves knowledge scoped above and below the folder asked about', async () => {
    const { service } = fakeIndex();
    await seed(service);

    const { hits } = await service.searchKnowledge(WORKSPACE, 'redis', {
      scope: 'apps/server/prisma',
    });

    expect(ids(hits)).toEqual(
      expect.arrayContaining(['server', 'migrations', 'globbed']),
    );
    expect(ids(hits)).not.toContain('webapp');
    expect(ids(hits)).not.toContain('types');
  });

  it('[KG-1.3] does not serve knowledge about a sibling folder', async () => {
    const { service } = fakeIndex();
    await seed(service);

    const { hits } = await service.searchKnowledge(WORKSPACE, 'redis', {
      scope: 'apps/webapp',
    });

    expect(ids(hits)).toContain('webapp');
    expect(ids(hits)).not.toContain('migrations');
    expect(ids(hits)).not.toContain('server');
  });

  it('[KG-1.3] keeps page bodies and unscoped entries, ranked below every scoped match', async () => {
    const { service } = fakeIndex();
    await seed(service);

    // "everywhere" matches the query text three times over, and still ranks
    // after the scoped matches: asking about a folder puts it first.
    const { hits } = await service.searchKnowledge(WORKSPACE, 'redis', {
      scope: 'apps/server',
    });
    const order = ids(hits);

    expect(order).toEqual(expect.arrayContaining(['everywhere', 'page:body']));
    const lastScoped = Math.max(
      order.indexOf('server'),
      order.indexOf('migrations'),
      order.indexOf('globbed'),
    );
    expect(order.indexOf('everywhere')).toBeGreaterThan(lastScoped);
    expect(order.indexOf('page:body')).toBeGreaterThan(lastScoped);
  });

  it('[KG-1.3] ranks by text match, as before, when no scope is given', async () => {
    const { service } = fakeIndex();
    await seed(service);

    const { hits } = await service.searchKnowledge(WORKSPACE, 'redis');

    expect(ids(hits)[0]).toBe('everywhere');
  });
});

describe('retrieval by kind', () => {
  it('[KG-1.4] serves only the kinds asked for, and no page bodies', async () => {
    const { service } = fakeIndex();
    await seed(service);

    const { hits } = await service.searchKnowledge(WORKSPACE, 'redis', {
      kinds: [PageEntryKindEnum.CONVENTION, PageEntryKindEnum.GOTCHA],
    });

    expect(ids(hits).sort()).toEqual(['globbed', 'migrations']);
    expect(hits.map((hit) => hit.entryKind).sort()).toEqual([
      'CONVENTION',
      'GOTCHA',
    ]);
  });

  it('[KG-1.4] ignores a kind that does not exist rather than filtering on it', async () => {
    const { service, searches } = fakeIndex();
    await seed(service);

    await service.searchKnowledge(WORKSPACE, 'redis', {
      kinds: ['OPINION` || workspaceId:=`other'],
    });

    expect(searches[0].filter_by).not.toContain('entryKind');
  });
});

describe('retrieval seeded from the product graph', () => {
  it('[KG-1.5] ranks the seed modules first, their neighbours next, and the rest after', async () => {
    const { service } = fakeIndex();
    await seed(service);

    // No question at all — the shape of load_context with only an issue.
    const { hits } = await service.searchKnowledge(WORKSPACE, '*', {
      boost: { modules: [SERVER], neighbours: [TYPES] },
    });
    const order = ids(hits);

    const serverKnowledge = ['server', 'migrations', 'globbed'].map((id) =>
      order.indexOf(id),
    );
    expect(Math.max(...serverKnowledge)).toBeLessThan(order.indexOf('types'));
    expect(order.indexOf('types')).toBeLessThan(order.indexOf('webapp'));
    expect(order.indexOf('types')).toBeLessThan(order.indexOf('everywhere'));
  });

  it('[KG-1.5] lets a boost reorder near-equal answers without burying a far better one', async () => {
    const { searches, service } = fakeIndex();

    // Twenty answers to "cache", entry `cN` mentioning it N times, so each is
    // a little more relevant than the last. Two of them are about the seed
    // module: c17, next to c18 in relevance, and c1, far behind everything.
    for (let n = 1; n <= 20; n++) {
      await service.indexEntry({
        id: `c${n}`,
        content: Array(n).fill('cache').join(' '),
        scope: null,
        status: PageEntryStatusEnum.STANDING,
        sourceUserId: 'agent-1',
        verifiedAt: null,
        retrievalCount: 0,
        updatedAt: new Date('2026-09-01'),
        pageId: `page-c${n}`,
        moduleIds: n === 17 || n === 1 ? [WEBAPP] : [],
        kind: PageEntryKindEnum.FACT,
        page: { title: 'Notes', workspaceId: WORKSPACE },
      });
    }

    const { hits } = await service.searchKnowledge(WORKSPACE, 'cache', {
      limit: 20,
      boost: { modules: [WEBAPP], neighbours: [] },
    });
    const order = ids(hits);

    // Relevance is bucketed first and the boost breaks ties inside a bucket:
    // c17 shares a bucket with c18 and overtakes it, but not c19 or c20, which
    // are in a better bucket, and c1 stays behind every far better answer.
    expect(String(searches[0].sort_by)).toMatch(
      /^_text_match\(buckets: \d+\):desc,_eval\(/,
    );
    expect(order.slice(0, 4)).toEqual(['c20', 'c19', 'c17', 'c18']);
    expect(order.indexOf('c1')).toBeGreaterThan(order.indexOf('c3'));
  });

  it('[KG-1.5] refuses to put anything but a module id into the ranking', async () => {
    const { searches, service } = fakeIndex();
    await seed(service);

    await service.searchKnowledge(WORKSPACE, '*', {
      boost: {
        modules: ['x`] || verified:true || moduleIds:=[`y'],
        neighbours: [],
      },
    });

    expect(searches[0].sort_by).not.toContain('moduleIds');
  });
});

describe('ranking by trust', () => {
  /**
   * Three entries that match a query equally, on pages of their own so the
   * per-page cap keeps all three: one a person verified, one grounded, one
   * with nothing checked behind it.
   */
  async function equals(service: VectorService, extra: Partial<Doc> = {}) {
    const entry = (
      id: string,
      verifiedAt: Date | null,
      checks: Array<string | null>,
    ) =>
      service.indexEntry({
        id,
        content: 'Deploys drain the worker pool first.',
        scope: null,
        status: PageEntryStatusEnum.STANDING,
        sourceUserId: 'agent-1',
        verifiedAt,
        retrievalCount: 0,
        updatedAt: new Date('2026-09-01'),
        pageId: `page-${id}`,
        moduleIds: [],
        kind: PageEntryKindEnum.FACT,
        citations: checks.map((checkResult) => ({
          kind: 'CODE',
          checkResult,
          checkedAt: null as Date | null,
        })),
        page: { title: 'Deploys', workspaceId: WORKSPACE },
        ...extra,
      });

    // Indexed worst first, so an order that merely kept insertion would fail.
    await entry('ungrounded', null, ['CHANGED']);
    await entry('grounded', null, ['HOLDS', 'MOVED']);
    await entry('verified', new Date(), []);
  }

  it("[KG-2.7] indexes each entry's trust as a facet, and none for a page body", async () => {
    const { service, docs } = fakeIndex();
    await seed(service);
    await equals(service);

    expect(pageSchema.fields.find((f) => f.name === 'trust')).toMatchObject({
      type: 'string',
      facet: true,
    });
    expect(docs.get('entry:verified')).toMatchObject({
      trust: 'HUMAN_VERIFIED',
    });
    expect(docs.get('entry:grounded')).toMatchObject({ trust: 'GROUNDED' });
    expect(docs.get('entry:ungrounded')).toMatchObject({
      trust: 'UNGROUNDED',
    });
    expect(docs.get('page:body')).toMatchObject({ trust: '' });
  });

  it('[KG-2.7] ranks human-verified above grounded above ungrounded for otherwise equal matches', async () => {
    const { service } = fakeIndex();
    await equals(service);

    const { hits } = await service.searchKnowledge(WORKSPACE, 'worker pool');

    expect(ids(hits)).toEqual(['verified', 'grounded', 'ungrounded']);
  });

  it('[KG-2.7] keeps that order inside a scope and inside a module boost', async () => {
    const scoped = fakeIndex();
    await equals(scoped.service, { scope: 'apps/server' });
    const { hits: inScope } = await scoped.service.searchKnowledge(
      WORKSPACE,
      'worker pool',
      { scope: 'apps/server' },
    );
    expect(ids(inScope)).toEqual(['verified', 'grounded', 'ungrounded']);

    const boosted = fakeIndex();
    await equals(boosted.service, { moduleIds: [SERVER] });
    const { hits: inModule } = await boosted.service.searchKnowledge(
      WORKSPACE,
      '*',
      { boost: { modules: [SERVER], neighbours: [] } },
    );
    expect(ids(inModule)).toEqual(['verified', 'grounded', 'ungrounded']);
  });

  it('[KG-2.7] never lets trust outrank what was asked for: a boosted module beats a grounded fact elsewhere', async () => {
    const { service } = fakeIndex();
    await equals(service);
    await service.indexEntry({
      id: 'seeded',
      content: 'Deploys drain the worker pool first.',
      scope: null,
      status: PageEntryStatusEnum.STANDING,
      sourceUserId: 'agent-1',
      verifiedAt: null,
      retrievalCount: 0,
      updatedAt: new Date('2026-09-01'),
      pageId: 'page-seeded',
      moduleIds: [SERVER],
      kind: PageEntryKindEnum.FACT,
      page: { title: 'Deploys', workspaceId: WORKSPACE },
    });

    const { hits } = await service.searchKnowledge(WORKSPACE, '*', {
      boost: { modules: [SERVER], neighbours: [] },
    });

    expect(ids(hits)[0]).toBe('seeded');
  });
});

describe('served proof', () => {
  it('[KG-2.8] serves every hit with its trust, citations and last check, read from postgres', async () => {
    const checkedAt = new Date('2026-09-20T10:00:00Z');
    const { service } = fakeIndex({
      server: {
        status: PageEntryStatusEnum.STANDING,
        verifiedAt: null,
        citations: [
          {
            kind: 'CODE',
            path: 'apps/server/src/redis.ts',
            commitSha: 'abcdef1',
            startLine: 10,
            endLine: 12,
            targetLabel: null,
            checkedAt,
            checkedSha: 'fedcba9',
            checkResult: 'HOLDS',
            judgment: null,
            judgeModel: null,
            moduleRepo: { fullName: 'acme/api' },
          },
        ],
      },
    });
    await seed(service);

    const { hits } = await service.searchKnowledge(WORKSPACE, 'redis');
    const byId = new Map(hits.map((hit) => [ids([hit])[0], hit]));

    expect(byId.get('server')).toMatchObject({
      trust: 'GROUNDED',
      citations: [
        {
          kind: 'CODE',
          repo: 'acme/api',
          path: 'apps/server/src/redis.ts',
          lines: '10-12',
          result: 'HOLDS',
          checkedSha: 'fedcba9',
        },
      ],
      lastCheckedAt: checkedAt.toISOString(),
      lastCheckedSha: 'fedcba9',
    });
    // Nothing checked behind it, whatever the index last recorded.
    expect(byId.get('webapp')).toMatchObject({
      trust: 'UNGROUNDED',
      citations: [],
      lastCheckedAt: null,
    });
    expect(byId.get('page:body')).toMatchObject({
      trust: null,
      citations: [],
    });
  });
});

describe('near entries, for triage', () => {
  const PAGE_ID = '00000000-0000-0000-0000-0000000000aa';

  /**
   * An index holding documents with a vector distance each. The search's own
   * filter is applied to them, so what comes back is what that filter lets
   * through.
   */
  function indexWith(docs: Array<Doc & { distance?: number }>) {
    const searches: Array<Record<string, string | number>> = [];
    const typesense = {
      multiSearch: {
        perform: async ({
          searches: [search],
        }: {
          searches: Array<Record<string, string | number>>;
        }) => {
          searches.push(search);
          const matches = parseFilter(search.filter_by as string);

          return {
            results: [
              {
                grouped_hits: [
                  {
                    hits: docs
                      .filter(({ distance: _distance, ...doc }) => matches(doc))
                      .map(({ distance, ...document }) => ({
                        document,
                        ...(distance !== undefined && {
                          vector_distance: distance,
                        }),
                      })),
                  },
                ],
                found: docs.length,
              },
            ],
          };
        },
      },
    } as unknown as TypesenseClient;
    // No page cites an entry here.
    const alive = async ({ where }: { where: { id?: { in: string[] } } }) =>
      (where.id?.in ?? []).map((id) => ({ id }));
    const prisma = {
      page: { findMany: alive },
      pageEntry: {
        findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.map((id) => ({
            id,
            status: 'STANDING',
            verifiedAt: null as Date | null,
            citations: [] as unknown[],
          })),
      },
    } as unknown as PrismaService;

    return { service: new VectorService(prisma, typesense), searches };
  }

  const doc = (
    entryId: string,
    extra: Partial<Doc> & { distance?: number },
  ): Doc & { distance?: number } => ({
    id: `entry:${entryId}`,
    kind: 'entry',
    entryId,
    pageId: `page-${entryId}`,
    workspaceId: WORKSPACE,
    status: 'STANDING',
    moduleIds: [SERVER],
    ...extra,
  });

  it('[KG-4.2] finds proposed and standing entries of the same modules, above the threshold only', async () => {
    const { service, searches } = indexWith([
      doc('close', { distance: 0.15 }),
      doc('proposed', { distance: 0.3, status: 'PROPOSED' }),
      doc('far', { distance: 0.55 }),
      doc('words-only', {}),
      doc('archived', { distance: 0.1, status: 'ARCHIVED' }),
      doc('webapp', { distance: 0.1, moduleIds: [WEBAPP] }),
      doc('other-workspace', {
        distance: 0.1,
        workspaceId: '00000000-0000-0000-0000-000000000009',
      }),
    ]);

    const near = await service.findNearEntries(WORKSPACE, 'webhook retries', {
      moduleIds: [SERVER],
      pageId: PAGE_ID,
      minSimilarity: 0.6,
    });

    expect(near).toEqual([
      { entryId: 'close', similarity: 0.85 },
      { entryId: 'proposed', similarity: 0.7 },
    ]);
    // The threshold is the index's distance ceiling too, so a far entry is
    // not even a candidate there.
    expect(searches[0].vector_query).toContain('distance_threshold:0.4');
    // With modules to look in, the page does not narrow it further.
    expect(searches[0].filter_by).not.toContain('pageId');
  });

  it('[KG-7.4] finds consolidated entries too, which are served as their page’s evidence, for triage and for the write-time check', async () => {
    const { service } = indexWith([
      doc('folded', { distance: 0.1, status: 'CONSOLIDATED', pageId: PAGE_ID }),
      doc('superseded', {
        distance: 0.1,
        status: 'SUPERSEDED',
        pageId: PAGE_ID,
      }),
    ]);

    const near = await service.findNearEntries(WORKSPACE, 'webhook retries', {
      moduleIds: [SERVER],
      minSimilarity: 0.6,
    });
    const similar = await service.findSimilarEntries(
      WORKSPACE,
      PAGE_ID,
      'webhook retries',
    );

    expect(near).toEqual([{ entryId: 'folded', similarity: 0.9 }]);
    expect(similar.map((hit) => hit.entryId)).toEqual(['folded']);
  });

  it('[KG-4.2] looks on the page instead, for an entry in no module', async () => {
    const { service, searches } = indexWith([
      doc('same-page', { distance: 0.2, pageId: PAGE_ID, moduleIds: [] }),
      doc('other-page', { distance: 0.2, moduleIds: [] }),
    ]);

    const near = await service.findNearEntries(WORKSPACE, 'webhook retries', {
      moduleIds: [],
      pageId: PAGE_ID,
      minSimilarity: 0.25,
    });

    expect(near.map((hit) => hit.entryId)).toEqual(['same-page']);
    expect(searches[0].filter_by).not.toContain('moduleIds');
  });
});

describe('entries a page cites', () => {
  const at = new Date('2026-09-01');
  const index = async (
    service: VectorService,
    id: string,
    content: string,
    extra: Doc = {},
  ) =>
    service.indexEntry({
      id,
      content,
      scope: null,
      status: PageEntryStatusEnum.STANDING,
      sourceUserId: 'agent-1',
      verifiedAt: null,
      retrievalCount: 0,
      updatedAt: at,
      pageId: 'notes',
      moduleIds: [],
      kind: PageEntryKindEnum.FACT,
      page: { title: 'Server notes', workspaceId: WORKSPACE },
      ...extra,
    } as Parameters<VectorService['indexEntry']>[0]);
  const page = (service: VectorService, id: string, title: string) =>
    service.indexPage({
      id,
      title,
      description: null,
      workspaceId: WORKSPACE,
      updatedAt: at,
    });

  it('[KG-7.3] reads every entry a page holds for a generated page’s refresh, and serves three a page to everyone else', async () => {
    const { service, searches } = fakeIndex();
    const facts = ['one', 'two', 'three', 'four', 'five'];
    for (const fact of facts) {
      await index(service, fact, `Deploys go out on merge, rule ${fact}.`);
    }

    const served = await service.searchKnowledge(WORKSPACE, 'deploys');
    const whole = await service.searchKnowledge(WORKSPACE, 'deploys', {
      limit: 40,
      ungrouped: true,
    });

    expect(served.hits).toHaveLength(3);
    expect(searches[0]).toMatchObject({ group_by: 'pageId', group_limit: 3 });
    expect(ids(whole.hits).sort()).toEqual([...facts].sort());
    expect(searches[1]).not.toHaveProperty('group_by');
    expect(searches[1]).not.toHaveProperty('group_limit');
    expect(searches[1].per_page).toBe(40);
  });

  it('[KG-7.4] serves an entry folded into a page, as evidence for it, ranked below it', async () => {
    const { service, searches } = fakeIndex({}, [
      { id: 'deploys', title: 'Deploys', citedEntryIds: ['folded'] },
    ]);
    await page(service, 'deploys', 'Deploys');
    await index(service, 'folded', 'deploys deploys deploys go out on merge', {
      status: PageEntryStatusEnum.CONSOLIDATED,
      pageId: 'deploys',
      page: { title: 'Deploys', workspaceId: WORKSPACE },
    });
    await index(service, 'replaced', 'deploys deploys deploys deploys', {
      status: PageEntryStatusEnum.SUPERSEDED,
    });
    await index(service, 'waiting', 'deploys deploys deploys deploys', {
      status: PageEntryStatusEnum.PROPOSED,
    });

    const { hits } = await service.searchKnowledge(WORKSPACE, 'deploys');

    // The index ranked the entry above the page's body, on more matches.
    expect(searches[0].filter_by).toContain(
      'status:=[`STANDING`,`CONSOLIDATED`]',
    );
    expect(ids(hits)).toEqual(['page:deploys', 'folded']);
    expect(hits[1]).toMatchObject({
      status: PageEntryStatusEnum.CONSOLIDATED,
      evidenceFor: { pageId: 'deploys', pageTitle: 'Deploys' },
    });
    expect(hits[0].evidenceFor).toBeUndefined();
  });

  it('[KG-7.4] ranks what a generated page cites below the page, and leaves the rest where it was', async () => {
    const { service } = fakeIndex({}, [
      // Cited by a page the search did not find, first: it is ranked under
      // the one it did, and marked as that one's.
      { id: 'other-guide', title: 'Rolling back', citedEntryIds: ['cited'] },
      { id: 'guide', title: 'Deploying', citedEntryIds: ['cited'] },
      // Neither a deleted page nor another workspace's is its page.
      {
        id: 'gone',
        title: 'Gone',
        citedEntryIds: ['loud'],
        deleted: new Date(),
      },
      {
        id: 'foreign',
        title: 'Foreign',
        citedEntryIds: ['loud'],
        workspaceId: 'workspace-2',
      },
    ]);
    await index(service, 'loud', 'deploying deploying deploying deploying', {
      pageId: 'elsewhere',
    });
    await index(service, 'cited', 'deploying deploying deploying');
    await page(service, 'guide', 'Deploying');

    const { hits } = await service.searchKnowledge(WORKSPACE, 'deploying');

    expect(ids(hits)).toEqual(['loud', 'page:guide', 'cited']);
    expect(hits[2].evidenceFor).toEqual({
      pageId: 'guide',
      pageTitle: 'Deploying',
    });
    expect(hits[0].evidenceFor).toBeUndefined();
  });

  it('[KG-7.4] marks evidence found after a page it is cited by as that page’s, where it was ranked', async () => {
    const { service } = fakeIndex({}, [
      { id: 'unseen', title: 'Rolling back', citedEntryIds: ['cited'] },
      { id: 'guide', title: 'Deploying', citedEntryIds: ['cited'] },
    ]);
    await page(service, 'guide', 'Deploying deploying deploying deploying');
    await index(service, 'loud', 'deploying deploying deploying', {
      pageId: 'elsewhere',
    });
    await index(service, 'cited', 'deploying deploying');

    const { hits } = await service.searchKnowledge(WORKSPACE, 'deploying');

    expect(ids(hits)).toEqual(['page:guide', 'loud', 'cited']);
    expect(hits[2].evidenceFor).toEqual({
      pageId: 'guide',
      pageTitle: 'Deploying',
    });
  });

  it('[KG-7.4] still serves the evidence when its page was not found, marked as its page’s', async () => {
    const { service } = fakeIndex({}, [
      { id: 'deploys', title: 'Deploys', citedEntryIds: ['folded'] },
    ]);
    await page(service, 'deploys', 'Deploys');
    await index(service, 'folded', 'Deploys go out on merge.', {
      status: PageEntryStatusEnum.CONSOLIDATED,
      pageId: 'deploys',
      page: { title: 'Deploys', workspaceId: WORKSPACE },
    });
    // Consolidated before pages kept what they cite: its own page's still.
    await index(service, 'older', 'Merges deploy on their own.', {
      status: PageEntryStatusEnum.CONSOLIDATED,
      pageId: 'runbook',
      page: { title: 'Runbook', workspaceId: WORKSPACE },
    });

    // Asking for facts leaves page bodies out.
    const { hits } = await service.searchKnowledge(WORKSPACE, 'merge', {
      kinds: [PageEntryKindEnum.FACT],
    });

    expect(ids(hits).sort()).toEqual(['folded', 'older']);
    const byId = new Map(hits.map((hit) => [hit.entryId, hit]));
    expect(byId.get('folded')?.evidenceFor).toEqual({
      pageId: 'deploys',
      pageTitle: 'Deploys',
    });
    expect(byId.get('older')?.evidenceFor).toEqual({
      pageId: 'runbook',
      pageTitle: 'Runbook',
    });
  });
});

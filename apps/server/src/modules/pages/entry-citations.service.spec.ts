/**
 * Checking what an entry rests on: when it is written, when its source could
 * not be read at the time, and later against the code as it is now.
 *
 * The database is an in-memory stand-in that applies the workspace scoping
 * the service asks for, so a target in another workspace is exactly as
 * invisible here as it is in postgres. Repository files come from a fake
 * source that answers content, missing or unknown per path and commit.
 */
import type { RepoFileRead, RepoHead } from 'integrations/repo-files';

import { UnprocessableEntityException } from '@nestjs/common';
import {
  PageEntryCitationCheckEnum,
  PageEntryCitationInputDto,
  PageEntryCitationJudgmentEnum,
  PageEntryCitationKindEnum,
} from '@vantikhq/types';
import { Queue } from 'bull';
import { PrismaService } from 'nestjs-prisma';

import { GitSourcesService } from 'modules/git/git-sources.service';
import { RepoMirrorService } from 'modules/git/repo-mirror.service';

import CitationJudge, { JudgeRequest } from './citation-judge';
import { hashSnippet } from './citation-matching';
import EntryCitationsService from './entry-citations.service';
import KnowledgeIndexService from './knowledge-index.service';
import { RETRY_CITATIONS_JOB } from './pages.interface';
import RepoFileSourceService, { CitedRepo } from './repo-file-source.service';

const WS = '00000000-0000-0000-0000-00000000000a';
const OTHER = '00000000-0000-0000-0000-00000000000b';
const uuid = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

const SHA1 = '1111111111111111111111111111111111111111';
const SHA2 = '2222222222222222222222222222222222222222';
/** When the stored citations were written. */
const WRITTEN = new Date('2026-01-01T00:00:00Z');

const PAGES_TS = [
  "import { archive } from './archive';", // 1
  '', // 2
  'export function removePage(page) {', // 3
  '  archive(page.entries);', // 4
  '}', // 5
  '',
].join('\n');

// ------------------------------------------------------------- the world

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function world() {
  const modules: Row[] = [
    { id: 'm-api', workspaceId: WS, deleted: null },
    { id: 'm-web', workspaceId: WS, deleted: null },
    { id: 'm-foreign', workspaceId: OTHER, deleted: null },
  ];
  const moduleRepos: Row[] = [
    {
      id: 'r-api',
      moduleId: 'm-api',
      fullName: 'acme/api',
      externalRepoId: '1',
      integrationAccountId: 'acct-1',
      pathPrefixes: [],
      deleted: null,
    },
    {
      id: 'r-web',
      moduleId: 'm-web',
      fullName: 'acme/web',
      externalRepoId: '2',
      integrationAccountId: 'acct-1',
      pathPrefixes: ['apps/web'],
      deleted: null,
    },
    {
      id: 'r-foreign',
      moduleId: 'm-foreign',
      fullName: 'rival/secret',
      externalRepoId: '3',
      integrationAccountId: 'acct-2',
      pathPrefixes: [],
      deleted: null,
    },
  ];
  const teams: Row[] = [
    { id: 't-eng', workspaceId: WS, identifier: 'ENG', deleted: null },
    { id: 't-ops', workspaceId: OTHER, identifier: 'OPS', deleted: null },
  ];
  const issues: Row[] = [
    { id: uuid(1), number: 42, teamId: 't-eng', deleted: null },
    { id: uuid(2), number: 7, teamId: 't-ops', deleted: null },
    { id: uuid(3), number: 9, teamId: 't-eng', deleted: new Date() },
  ];
  const linkedIssues: Row[] = [
    {
      id: uuid(11),
      issueId: uuid(1),
      url: 'https://github.com/acme/api/pull/5',
      deleted: null,
    },
    {
      id: uuid(12),
      issueId: uuid(2),
      url: 'https://github.com/rival/secret/pull/1',
      deleted: null,
    },
  ];
  const comments: Row[] = [
    { id: uuid(21), issueId: uuid(1), deleted: null },
    { id: uuid(22), issueId: uuid(2), deleted: null },
  ];
  const runs: Row[] = [
    { id: uuid(31), workspaceId: WS, deleted: null, modelId: 'vendor/fast' },
    { id: uuid(32), workspaceId: OTHER, deleted: null, modelId: 'x' },
  ];
  const entries: Row[] = [];
  const citations: Row[] = [];

  const moduleOf = (row: Row) => modules.find((m) => m.id === row.moduleId);
  const teamOf = (issue: Row) => teams.find((t) => t.id === issue.teamId);
  const issueIn = (issueId: string, where: Row) => {
    const issue = issues.find((i) => i.id === issueId);
    return Boolean(issue) && matchesIssue(issue, where);
  };
  const matchesTeam = (team: Row | undefined, where: Row = {}) =>
    Boolean(team) &&
    (where.workspaceId === undefined ||
      team.workspaceId === where.workspaceId) &&
    (where.deleted === undefined || team.deleted === where.deleted) &&
    (where.identifier === undefined || team.identifier === where.identifier);
  const matchesIssue = (issue: Row, where: Row = {}) =>
    (where.id === undefined || issue.id === where.id) &&
    (where.number === undefined || issue.number === where.number) &&
    (where.deleted === undefined || issue.deleted === where.deleted) &&
    (where.team === undefined || matchesTeam(teamOf(issue), where.team));
  const select = (row: Row | undefined) => (row ? { ...row } : null);

  const accounts: Row[] = [
    { id: 'acct-1', workspaceId: WS, deleted: null, slug: 'github' },
    { id: 'acct-2', workspaceId: OTHER, deleted: null, slug: 'github' },
  ];

  const prisma = {
    integrationAccount: {
      findFirst: async ({ where }: Row) => {
        const account = accounts.find(
          (a) =>
            a.id === where.id &&
            a.workspaceId === where.workspaceId &&
            a.deleted === null,
        );
        return account
          ? { integrationDefinition: { slug: account.slug } }
          : null;
      },
    },
    moduleRepo: {
      findMany: async ({ where }: Row) =>
        moduleRepos.filter(
          (row) =>
            row.deleted === null &&
            moduleOf(row)?.workspaceId === where.module.workspaceId &&
            moduleOf(row)?.deleted === null,
        ),
      findFirst: async ({ where }: Row) => {
        const row = moduleRepos.find(
          (candidate) =>
            (where.id === undefined || candidate.id === where.id) &&
            (where.deleted === undefined ||
              candidate.deleted === where.deleted) &&
            (where.externalRepoId === undefined ||
              candidate.externalRepoId === where.externalRepoId) &&
            (where.integrationAccountId === undefined ||
              candidate.integrationAccountId === where.integrationAccountId) &&
            moduleOf(candidate)?.workspaceId === where.module.workspaceId &&
            (where.module.deleted === undefined ||
              moduleOf(candidate)?.deleted === where.module.deleted),
        );
        return row
          ? { ...row, module: { deleted: moduleOf(row)?.deleted ?? null } }
          : null;
      },
    },
    issue: {
      findFirst: async ({ where }: Row) => {
        const issue = issues.find((i) => matchesIssue(i, where));
        return issue
          ? { ...issue, team: { identifier: teamOf(issue).identifier } }
          : null;
      },
    },
    linkedIssue: {
      findFirst: async ({ where }: Row) =>
        select(
          linkedIssues.find(
            (link) =>
              link.deleted === null &&
              (where.id === undefined || link.id === where.id) &&
              (where.url === undefined || link.url === where.url) &&
              issueIn(link.issueId, where.issue),
          ),
        ),
    },
    issueComment: {
      findFirst: async ({ where }: Row) =>
        select(
          comments.find(
            (comment) =>
              comment.id === where.id &&
              comment.deleted === null &&
              issueIn(comment.issueId, where.issue),
          ),
        ),
    },
    agentRun: {
      findFirst: async ({ where }: Row) =>
        select(
          runs.find(
            (run) =>
              run.id === where.id &&
              run.workspaceId === where.workspaceId &&
              (where.deleted === undefined || run.deleted === where.deleted),
          ),
        ),
    },
    pageEntry: {
      findFirst: async ({ where }: Row) => {
        const entry = entries.find(
          (e) => e.id === where.id && e.deleted === null,
        );
        return entry
          ? {
              ...entry,
              page: { workspaceId: entry.workspaceId },
              citations: citations
                .filter((c) => c.entryId === entry.id)
                .map((c) => ({ ...c })),
            }
          : null;
      },
    },
    pageEntryCitation: {
      update: jest.fn(async ({ where, data }: Row) => {
        const row = citations.find((c) => c.id === where.id);
        Object.assign(row, data);
        return row;
      }),
      // Stored only over an older reading, as a re-check stores a reading
      // of a head, or only over no reading, as a reading of the commit a
      // citation cites is stored.
      updateMany: jest.fn(async ({ where, data }: Row) => {
        const row = citations.find((c) => c.id === where.id);
        const older =
          where.OR === undefined ||
          (where.OR as Row[]).some((part) =>
            part.checkedAt === null
              ? row?.checkedAt == null
              : row?.checkedAt instanceof Date &&
                row.checkedAt < (part.checkedAt as { lt: Date }).lt,
          );
        const unread =
          where.checkResult === undefined ||
          row?.checkResult === where.checkResult;

        if (!row || !older || !unread) {
          return { count: 0 };
        }

        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    $executeRaw: jest.fn(async () => 1),
  } as unknown as PrismaService;
  (prisma as unknown as Row).$transaction = async (
    work: (tx: PrismaService) => unknown,
  ) => work(prisma);

  return { prisma, issues, citations, entries, moduleRepos };
}

/** Files by repository, commit and path; a head per repository. */
function fakeFiles() {
  const files = new Map<string, RepoFileRead>();
  const heads = new Map<string, RepoHead>();
  const source = {
    read: jest.fn(
      async (repo: CitedRepo, path: string, ref: string) =>
        files.get(`${repo.fullName}@${ref}:${path}`) ?? { missing: true },
    ),
    head: jest.fn(
      async (repo: CitedRepo) =>
        heads.get(repo.fullName) ?? { unknown: true, reason: 'down' },
    ),
  };
  const put = (repo: string, ref: string, path: string, read: RepoFileRead) =>
    files.set(`${repo}@${ref}:${path}`, read);

  return { source, put, heads };
}

function setup() {
  const db = world();
  const files = fakeFiles();
  const judge = {
    judge: jest.fn(async (request: JudgeRequest) => ({
      verdict: PageEntryCitationJudgmentEnum.HOLDS,
      lines: `${request.region.startLine}`,
      reason: 'still archives',
      model: 'vendor/smart',
    })),
  };
  const queue = { add: jest.fn(async (): Promise<void> => undefined) };
  const indexer = {
    entryChanged: jest.fn(async (): Promise<void> => undefined),
  };
  const service = new EntryCitationsService(
    db.prisma,
    files.source as unknown as RepoFileSourceService,
    judge as unknown as CitationJudge,
    indexer as unknown as KnowledgeIndexService,
    queue as unknown as Queue,
  );

  files.put('acme/api', SHA1, 'src/pages.ts', { content: PAGES_TS });
  files.heads.set('acme/api', { sha: SHA1 });

  return { service, db, files, judge, queue, indexer };
}

async function refusalOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    return (error as UnprocessableEntityException).getResponse() as {
      status: string;
      citation: number;
      message: string;
    };
  }
  throw new Error('the write was not refused');
}

/** Stores an entry with the given citations, as createEntry would. */
function store(
  db: ReturnType<typeof world>,
  drafts: Row[],
  entry: Partial<Row> = {},
) {
  const id = uuid(100 + db.entries.length);
  db.entries.push({
    id,
    content: 'Removing a page archives its entries.',
    sourceSession: null,
    workspaceId: WS,
    deleted: null,
    ...entry,
  });
  drafts.forEach((draft, index) =>
    db.citations.push({
      id: `${id}-c${index}`,
      entryId: id,
      createdAt: WRITTEN,
      moduleRepoId: null,
      path: null,
      commitSha: null,
      startLine: null,
      endLine: null,
      snippet: null,
      targetId: null,
      pendingQuote: null,
      ...draft,
    }),
  );
  return id;
}

const code = (
  extra: Partial<PageEntryCitationInputDto> = {},
): PageEntryCitationInputDto => ({
  path: 'src/pages.ts',
  lines: '3-5',
  sha: SHA1,
  ...extra,
});

// ------------------------------------------------------------ at write

describe('checking citations when an entry is written', () => {
  it('[KG-2.1] [KG-2.2] records a code citation that holds, with the snippet the server read itself', async () => {
    const { service } = setup();
    const snippet =
      'export function removePage(page) {\narchive(page.entries);\n}';

    const [draft] = await service.checkForWrite(WS, [
      // A snippet from the writer is not part of the input, and is ignored
      // if one is sent anyway.
      { ...code(), snippet: 'something else' } as PageEntryCitationInputDto,
    ]);

    expect(draft).toMatchObject({
      kind: PageEntryCitationKindEnum.CODE,
      moduleRepoId: 'r-api',
      path: 'src/pages.ts',
      commitSha: SHA1,
      startLine: 3,
      endLine: 5,
      snippet,
      snippetHash: hashSnippet(snippet),
      checkedSha: SHA1,
      checkResult: PageEntryCitationCheckEnum.HOLDS,
    });
    expect(draft.checkedAt).toBeInstanceOf(Date);
  });

  it('[KG-2.2] cites the head of the default branch when no commit is given', async () => {
    const { service, files } = setup();
    files.heads.set('acme/api', { sha: SHA2 });
    files.put('acme/api', SHA2, 'src/pages.ts', { content: PAGES_TS });

    const [draft] = await service.checkForWrite(WS, [code({ sha: undefined })]);

    expect(draft).toMatchObject({ commitSha: SHA2, checkResult: 'HOLDS' });
  });

  it('[KG-2.2] refuses the write when the cited lines do not say what was quoted, naming the citation', async () => {
    const { service } = setup();

    const refusal = await refusalOf(
      service.checkForWrite(WS, [
        code(),
        code({ lines: '1', quote: 'archive(page.entries)' }),
      ]),
    );

    expect(refusal).toEqual({
      status: 'citation-failed',
      citation: 2,
      message: expect.stringMatching(
        /^Nothing was written: citation 2 .*the quoted text is not in lines 1 of acme\/api:src\/pages\.ts/,
      ),
    });
  });

  it('[KG-2.2] refuses a file that is not at the commit, and lines past its end', async () => {
    const { service } = setup();

    expect(
      (
        await refusalOf(
          service.checkForWrite(WS, [code({ path: 'src/gone.ts' })]),
        )
      ).message,
    ).toContain('src/gone.ts at 111111111111 is not a file there');
    expect(
      (await refusalOf(service.checkForWrite(WS, [code({ lines: '4-9' })])))
        .message,
    ).toContain('the file has 5 lines at that commit');
  });

  it('[KG-2.2] refuses a citation that is malformed or names no single thing', async () => {
    const { service } = setup();

    for (const [input, reason] of [
      [code({ path: '../etc/passwd' }), 'not a path inside a repository'],
      [code({ lines: undefined }), 'needs lines'],
      [code({ sha: 'main' }), 'not a commit id'],
      [{}, 'names nothing to cite'],
      [{ ...code(), issue: 'ENG-42' }, 'names path and issue'],
    ] as Array<[PageEntryCitationInputDto, string]>) {
      expect(
        (await refusalOf(service.checkForWrite(WS, [input]))).message,
      ).toContain(reason);
    }
  });

  it('[KG-2.2] finds the repository from the path, and asks for it by name when that is ambiguous', async () => {
    const { service, db, files } = setup();
    files.put('acme/web', SHA1, 'apps/web/page.tsx', { content: 'web();\n' });

    const [web] = await service.checkForWrite(WS, [
      { path: 'apps/web/page.tsx', lines: '1', sha: SHA1 },
    ]);
    expect(web.moduleRepoId).toBe('r-web');

    // A second repository that claims the whole of itself makes a path
    // outside every folder ambiguous.
    db.moduleRepos.push({
      ...db.moduleRepos[0],
      id: 'r-docs',
      fullName: 'acme/docs',
      externalRepoId: '9',
    });

    expect(
      (await refusalOf(service.checkForWrite(WS, [code()]))).message,
    ).toContain('could be in acme/api or acme/docs. Name the repository');

    const [named] = await service.checkForWrite(WS, [
      code({ repo: 'ACME/api' }),
    ]);
    expect(named.moduleRepoId).toBe('r-api');
  });

  it("[KG-2.2] never reads another workspace's repository", async () => {
    const { service, files } = setup();

    expect(
      (
        await refusalOf(
          service.checkForWrite(WS, [code({ repo: 'rival/secret' })]),
        )
      ).message,
    ).toContain('no module in this workspace uses');
    expect(files.source.read).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------ an unreachable source

describe('a repository that cannot be reached', () => {
  it('[KG-2.3] gives an UNKNOWN citation, lets the write through, and queues a retry', async () => {
    const { service, files, queue } = setup();
    files.put('acme/api', SHA1, 'src/pages.ts', {
      unknown: true,
      reason: 'GitHub answered 503',
    });

    const drafts = await service.checkForWrite(WS, [code()]);

    expect(drafts[0]).toMatchObject({
      checkResult: PageEntryCitationCheckEnum.UNKNOWN,
      commitSha: SHA1,
      checkedAt: null,
    });
    expect(drafts[0].snippet).toBeUndefined();

    await service.retryLater('entry-1', drafts);

    expect(queue.add).toHaveBeenCalledWith(
      RETRY_CITATIONS_JOB,
      { entryId: 'entry-1' },
      expect.objectContaining({
        jobId: `${RETRY_CITATIONS_JOB}:entry-1`,
        attempts: expect.any(Number),
        backoff: expect.objectContaining({ type: 'exponential' }),
      }),
    );
  });

  it('[KG-2.3] queues nothing when every citation was read', async () => {
    const { service, queue } = setup();

    await service.retryLater(
      'entry-1',
      await service.checkForWrite(WS, [code()]),
    );

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('[KG-2.3] reads an unread citation once the repository answers, and counts those still unread', async () => {
    const { service, db, files, indexer } = setup();
    const entryId = store(db, [
      {
        kind: 'CODE',
        moduleRepoId: 'r-api',
        path: 'src/pages.ts',
        commitSha: SHA1,
        startLine: 3,
        endLine: 5,
        checkResult: 'UNKNOWN',
      },
      {
        kind: 'CODE',
        moduleRepoId: 'r-api',
        path: 'src/slow.ts',
        commitSha: SHA1,
        startLine: 1,
        endLine: 1,
        checkResult: 'UNKNOWN',
      },
    ]);
    files.put('acme/api', SHA1, 'src/slow.ts', { unknown: true, reason: 'x' });

    await expect(service.retryUnknown(entryId)).resolves.toEqual({
      stillUnknown: 1,
      read: 1,
    });

    // Stamped with when it was written: it says whether the claim held at
    // the commit it was written against.
    expect(db.citations[0]).toMatchObject({
      checkResult: 'HOLDS',
      snippet: 'export function removePage(page) {\narchive(page.entries);\n}',
      checkedSha: SHA1,
      checkedAt: WRITTEN,
    });
    expect(db.citations[1].checkResult).toBe('UNKNOWN');
    expect(indexer.entryChanged).toHaveBeenCalledWith(entryId);
  });

  it('[KG-2.3] records a citation whose lines never existed as missing once it can be read', async () => {
    const { service, db } = setup();
    const entryId = store(db, [
      {
        kind: 'CODE',
        moduleRepoId: 'r-api',
        path: 'src/pages.ts',
        commitSha: SHA1,
        startLine: 50,
        endLine: 60,
        checkResult: 'UNKNOWN',
      },
    ]);

    await expect(service.retryUnknown(entryId)).resolves.toEqual({
      stillUnknown: 0,
      read: 1,
    });
    expect(db.citations[0].checkResult).toBe('MISSING');
  });
});

describe('a repository that throws instead of answering', () => {
  it('[KG-2.3] still lets the write through with an UNKNOWN citation', async () => {
    const { db, judge, queue, indexer } = setup();
    // The real file source, over a mirror whose fetch rejects (here a token
    // refresh that cannot reach GitHub).
    const failing = jest.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND github.com');
    });
    const source = new RepoFileSourceService(
      {
        resolve: jest.fn(async () => ({ source: {}, repo: {} })),
      } as unknown as GitSourcesService,
      { readFile: failing, head: failing } as unknown as RepoMirrorService,
    );
    const service = new EntryCitationsService(
      db.prisma,
      source,
      judge as unknown as CitationJudge,
      indexer as unknown as KnowledgeIndexService,
      queue as unknown as Queue,
    );

    const drafts = await service.checkForWrite(WS, [
      code(),
      code({ sha: undefined }),
    ]);

    expect(drafts.map((draft) => draft.checkResult)).toEqual([
      PageEntryCitationCheckEnum.UNKNOWN,
      PageEntryCitationCheckEnum.UNKNOWN,
    ]);
  });
});

describe('a quote that could not be checked at write', () => {
  function unreachable() {
    const context = setup();
    context.files.put('acme/api', SHA1, 'src/pages.ts', {
      unknown: true,
      reason: 'GitHub answered 503',
    });
    return context;
  }

  it('[KG-2.3] is kept with the unread citation, and checked when the retry reads the lines', async () => {
    const context = unreachable();
    const quote = 'archive(page.entries)';

    const [draft] = await context.service.checkForWrite(WS, [code({ quote })]);
    expect(draft).toMatchObject({
      checkResult: 'UNKNOWN',
      pendingQuote: quote,
    });

    const entryId = store(context.db, [draft]);
    context.files.put('acme/api', SHA1, 'src/pages.ts', { content: PAGES_TS });

    await context.service.retryUnknown(entryId);

    expect(context.db.citations[0]).toMatchObject({
      checkResult: 'HOLDS',
      pendingQuote: null,
    });
  });

  it('[KG-2.3] fails the citation, keeping no snippet, when the lines do not say what was quoted', async () => {
    const context = unreachable();

    const [draft] = await context.service.checkForWrite(WS, [
      // Line 1 is the import, not the call the writer quoted.
      code({ lines: '1', quote: 'archive(page.entries)' }),
    ]);
    const entryId = store(context.db, [draft]);
    context.files.put('acme/api', SHA1, 'src/pages.ts', { content: PAGES_TS });

    await context.service.retryUnknown(entryId);

    expect(context.db.citations[0]).toMatchObject({
      checkResult: 'MISSING',
      snippet: null,
      pendingQuote: null,
    });

    // With no snippet there is nothing a later check could find to hold.
    context.files.heads.set('acme/api', { sha: SHA1 });
    await context.service.recheck(entryId);
    expect(context.db.citations[0].checkResult).toBe('MISSING');
  });
});

describe('a citation still unread when the retries have run out', () => {
  it('[KG-2.3] is read by the next check, at the commit it cites', async () => {
    const { service, db, files } = setup();
    const entryId = store(db, [
      {
        kind: 'CODE',
        moduleRepoId: 'r-api',
        path: 'src/pages.ts',
        commitSha: SHA1,
        startLine: 3,
        endLine: 5,
        checkResult: 'UNKNOWN',
      },
    ]);
    // The head has moved on; the citation is read at its own commit.
    files.heads.set('acme/api', { sha: SHA2 });

    await expect(service.recheck(entryId)).resolves.toEqual({ checked: 1 });
    expect(db.citations[0]).toMatchObject({
      checkResult: 'HOLDS',
      checkedSha: SHA1,
      snippet: 'export function removePage(page) {\narchive(page.entries);\n}',
    });
  });

  it('[KG-2.3] stays unread, untouched, while the repository still does not answer', async () => {
    const { service, db, files, indexer } = setup();
    const entryId = store(db, [
      {
        kind: 'CODE',
        moduleRepoId: 'r-api',
        path: 'src/pages.ts',
        commitSha: SHA1,
        startLine: 3,
        endLine: 5,
        checkResult: 'UNKNOWN',
      },
    ]);
    files.put('acme/api', SHA1, 'src/pages.ts', { unknown: true, reason: 'x' });

    await expect(service.recheck(entryId)).resolves.toEqual({ checked: 0 });
    expect(db.citations[0].checkResult).toBe('UNKNOWN');
    expect(indexer.entryChanged).not.toHaveBeenCalled();
  });
});

describe('a repository that stops answering during a write', () => {
  it('[KG-2.3] is asked once: the rest of its citations are unread without waiting on it again', async () => {
    const { service, files } = setup();
    files.put('acme/api', SHA1, 'src/pages.ts', {
      unknown: true,
      reason: 'the repository did not answer within 15 seconds',
    });

    const drafts = await service.checkForWrite(WS, [
      code(),
      code({ lines: '1' }),
      code({ lines: '4' }),
    ]);

    expect(drafts.map((draft) => draft.checkResult)).toEqual([
      'UNKNOWN',
      'UNKNOWN',
      'UNKNOWN',
    ]);
    expect(files.source.read).toHaveBeenCalledTimes(1);
  });

  it('[KG-2.3] is still asked after a file it could not read for a reason of its own', async () => {
    const { service, files } = setup();
    files.put('acme/api', SHA1, 'src/big.json', {
      unknown: true,
      reason: 'the file is too large to check',
      thisFileOnly: true,
    });

    const drafts = await service.checkForWrite(WS, [
      code({ path: 'src/big.json', lines: '1' }),
      code(),
    ]);

    expect(drafts.map((draft) => draft.checkResult)).toEqual([
      'UNKNOWN',
      'HOLDS',
    ]);
  });
});

describe('a repository that moved to another module', () => {
  function moved(context: ReturnType<typeof setup>) {
    // Moving a repository between modules deletes its row and creates one.
    context.db.moduleRepos[0].deleted = new Date();
    context.db.moduleRepos.push({
      ...context.db.moduleRepos[0],
      id: 'r-api-moved',
      moduleId: 'm-web',
      deleted: null,
    });
  }

  it('[KG-2.4] is still read, and its citations move to the live row', async () => {
    const context = setup();
    const entryId = store(context.db, [
      {
        kind: 'CODE',
        moduleRepoId: 'r-api',
        path: 'src/pages.ts',
        commitSha: SHA1,
        startLine: 3,
        endLine: 5,
        snippet:
          'export function removePage(page) {\narchive(page.entries);\n}',
        checkResult: 'HOLDS',
      },
    ]);
    moved(context);

    await context.service.recheck(entryId);

    expect(context.db.citations[0]).toMatchObject({
      moduleRepoId: 'r-api-moved',
      checkResult: 'HOLDS',
      checkedSha: SHA1,
    });
  });

  it('[KG-2.3] is read by the retry through the live row', async () => {
    const context = setup();
    const entryId = store(context.db, [
      {
        kind: 'CODE',
        moduleRepoId: 'r-api',
        path: 'src/pages.ts',
        commitSha: SHA1,
        startLine: 3,
        endLine: 5,
        checkResult: 'UNKNOWN',
      },
    ]);
    moved(context);

    await expect(context.service.retryUnknown(entryId)).resolves.toEqual({
      stillUnknown: 0,
      read: 1,
    });
    expect(context.db.citations[0]).toMatchObject({
      moduleRepoId: 'r-api-moved',
      checkResult: 'HOLDS',
    });
  });
});

describe('repository heads', () => {
  it('[KG-2.3] are resolved once per repository in a write, however many of its files are cited', async () => {
    const { service, files } = setup();

    await service.checkForWrite(WS, [
      code({ sha: undefined }),
      code({ sha: undefined, lines: '1' }),
      code({ sha: undefined, lines: '4' }),
    ]);

    expect(files.source.head).toHaveBeenCalledTimes(1);
  });

  it('[KG-2.4] are resolved once per repository in a check', async () => {
    const { service, db, files } = setup();
    const snippet = 'archive(page.entries);';
    const entryId = store(db, [
      {
        kind: 'CODE',
        moduleRepoId: 'r-api',
        path: 'src/pages.ts',
        commitSha: SHA1,
        startLine: 4,
        endLine: 4,
        snippet,
        checkResult: 'HOLDS',
      },
      {
        kind: 'CODE',
        moduleRepoId: 'r-api',
        path: 'src/pages.ts',
        commitSha: SHA1,
        startLine: 4,
        endLine: 4,
        snippet,
        checkResult: 'HOLDS',
      },
    ]);

    await service.recheck(entryId);

    expect(files.source.head).toHaveBeenCalledTimes(1);
  });
});

// ----------------------------------------------------- against current code

describe('re-checking a code citation against the default branch', () => {
  function cited(
    setupResult: ReturnType<typeof setup>,
    entry: Partial<Row> = {},
  ) {
    return store(
      setupResult.db,
      [
        {
          kind: 'CODE',
          moduleRepoId: 'r-api',
          path: 'src/pages.ts',
          commitSha: SHA1,
          startLine: 3,
          endLine: 5,
          snippet:
            'export function removePage(page) {\narchive(page.entries);\n}',
          checkResult: 'HOLDS',
        },
      ],
      entry,
    );
  }

  it('[KG-2.4] holds when the lines read the same at the head', async () => {
    const context = setup();
    const entryId = cited(context);
    context.files.heads.set('acme/api', { sha: SHA2 });
    context.files.put('acme/api', SHA2, 'src/pages.ts', { content: PAGES_TS });

    await context.service.recheck(entryId);

    expect(context.db.citations[0]).toMatchObject({
      checkResult: 'HOLDS',
      checkedSha: SHA2,
      startLine: 3,
      endLine: 5,
    });
    expect(context.judge.judge).not.toHaveBeenCalled();
    expect(context.indexer.entryChanged).toHaveBeenCalledWith(entryId);
  });

  it('[KG-2.4] moved, with the line range updated, when the lines are elsewhere in the file', async () => {
    const context = setup();
    const entryId = cited(context);
    context.files.heads.set('acme/api', { sha: SHA2 });
    context.files.put('acme/api', SHA2, 'src/pages.ts', {
      content: `// a new header\n\n${PAGES_TS}`,
    });

    await context.service.recheck(entryId);

    expect(context.db.citations[0]).toMatchObject({
      checkResult: 'MOVED',
      startLine: 5,
      endLine: 7,
    });
    expect(context.judge.judge).not.toHaveBeenCalled();
  });

  it('[KG-2.4] missing when the file is gone', async () => {
    const context = setup();
    const entryId = cited(context);
    context.files.heads.set('acme/api', { sha: SHA2 });

    await context.service.recheck(entryId);

    expect(context.db.citations[0]).toMatchObject({
      checkResult: 'MISSING',
      checkedSha: SHA2,
    });
  });

  it('[KG-2.4] keeps the last result when the repository cannot be reached', async () => {
    const context = setup();
    const entryId = cited(context);
    context.files.heads.set('acme/api', { unknown: true, reason: 'down' });

    await expect(context.service.recheck(entryId)).resolves.toEqual({
      checked: 0,
    });
    expect(context.db.citations[0].checkResult).toBe('HOLDS');
    expect(context.indexer.entryChanged).not.toHaveBeenCalled();
  });

  it('[KG-2.4] [KG-2.5] changed when the lines are gone, and only then asks a judge, recording its answer and model', async () => {
    const context = setup();
    const entryId = cited(context, { sourceSession: uuid(31) });
    context.files.heads.set('acme/api', { sha: SHA2 });
    context.files.put('acme/api', SHA2, 'src/pages.ts', {
      content: PAGES_TS.replace('archive(page.entries);', 'destroy(page);'),
    });

    await context.service.recheck(entryId);

    expect(context.db.citations[0]).toMatchObject({
      checkResult: 'CHANGED',
      judgment: 'HOLDS',
      judgeModel: 'vendor/smart',
      judgeReason: 'still archives',
      judgeLines: '1',
    });

    const [request] = context.judge.judge.mock.calls[0];
    expect(request).toMatchObject({
      claim: 'Removing a page archives its entries.',
      path: 'src/pages.ts',
      snippet: 'export function removePage(page) {\narchive(page.entries);\n}',
      region: { startLine: 1 },
      // The run that wrote the entry recorded its model; the judge is told,
      // so it can be a different one.
      writerModel: 'vendor/fast',
    });
    expect(request.region.lines).toContain('  destroy(page);');
  });

  it("[KG-2.5] does not take a writer's model from a run in another workspace", async () => {
    const context = setup();
    const entryId = cited(context, { sourceSession: uuid(32) });
    context.files.heads.set('acme/api', { sha: SHA2 });
    context.files.put('acme/api', SHA2, 'src/pages.ts', { content: 'x();\n' });

    await context.service.recheck(entryId);

    expect(context.judge.judge.mock.calls[0][0].writerModel).toBeNull();
  });

  it('[KG-2.5] shows the judge the end of a file that shrank past the old lines', async () => {
    const context = setup();
    const entryId = store(context.db, [
      {
        kind: 'CODE',
        moduleRepoId: 'r-api',
        path: 'src/pages.ts',
        commitSha: SHA1,
        startLine: 60,
        endLine: 70,
        snippet: 'long gone();',
        checkResult: 'HOLDS',
      },
    ]);
    context.files.heads.set('acme/api', { sha: SHA2 });
    context.files.put('acme/api', SHA2, 'src/pages.ts', { content: PAGES_TS });

    await context.service.recheck(entryId);

    const [request] = context.judge.judge.mock.calls[0];
    expect(request.region.startLine).toBe(1);
    expect(request.region.lines).toContain('  archive(page.entries);');
  });

  it('[KG-2.4] missing once the repository is removed from the workspace, as the retry has it', async () => {
    const context = setup();
    const entryId = cited(context);
    const unread = store(context.db, [
      {
        kind: 'CODE',
        moduleRepoId: 'r-api',
        path: 'src/pages.ts',
        commitSha: SHA1,
        startLine: 3,
        endLine: 5,
        checkResult: 'UNKNOWN',
      },
    ]);
    context.db.moduleRepos[0].deleted = new Date();

    await context.service.recheck(entryId);
    await context.service.retryUnknown(unread);

    expect(context.db.citations.map((c) => c.checkResult)).toEqual([
      'MISSING',
      'MISSING',
    ]);
    expect(context.files.source.read).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------ non-code

describe('citations of issues, pull requests, comments and runs', () => {
  it('[KG-2.6] holds for a target in the workspace, named by key, id or URL', async () => {
    const { service } = setup();

    const drafts = await service.checkForWrite(WS, [
      { issue: 'eng-42' },
      { issue: uuid(1) },
      { pullRequest: 'https://github.com/acme/api/pull/5' },
      { comment: uuid(21) },
      { run: uuid(31) },
    ]);

    expect(
      drafts.map(({ kind, targetId, targetLabel, checkResult }) => ({
        kind,
        targetId,
        targetLabel,
        checkResult,
      })),
    ).toEqual([
      {
        kind: 'ISSUE',
        targetId: uuid(1),
        targetLabel: 'ENG-42',
        checkResult: 'HOLDS',
      },
      {
        kind: 'ISSUE',
        targetId: uuid(1),
        targetLabel: 'ENG-42',
        checkResult: 'HOLDS',
      },
      {
        kind: 'PULL_REQUEST',
        targetId: uuid(11),
        targetLabel: 'https://github.com/acme/api/pull/5',
        checkResult: 'HOLDS',
      },
      {
        kind: 'COMMENT',
        targetId: uuid(21),
        targetLabel: uuid(21),
        checkResult: 'HOLDS',
      },
      {
        kind: 'RUN',
        targetId: uuid(31),
        targetLabel: uuid(31),
        checkResult: 'HOLDS',
      },
    ]);
  });

  it('[KG-2.6] fails a deleted target or one in another workspace', async () => {
    const { service } = setup();

    for (const input of [
      { issue: 'OPS-7' },
      { issue: uuid(2) },
      { issue: 'ENG-9' },
      { pullRequest: 'https://github.com/rival/secret/pull/1' },
      { comment: uuid(22) },
      { run: uuid(32) },
    ]) {
      const refusal = await refusalOf(service.checkForWrite(WS, [input]));
      expect(refusal.message).toContain('is not in this workspace');
    }
  });

  it('[KG-2.6] fails on re-check once the target is deleted', async () => {
    const { service, db } = setup();
    const entryId = store(db, [
      { kind: 'ISSUE', targetId: uuid(1), checkResult: 'HOLDS' },
      { kind: 'RUN', targetId: uuid(31), checkResult: 'HOLDS' },
    ]);
    db.issues[0].deleted = new Date();

    await service.recheck(entryId);

    expect(db.citations.map((c) => c.checkResult)).toEqual([
      'MISSING',
      'HOLDS',
    ]);
  });
});

// ------------------------------------------------------- outside pages

describe('citations of an outside page', () => {
  const URL_ = 'https://docs.vendor.example/limits';
  const QUOTE = 'Each key can make 100 requests per second.';

  function withPage(content: string | null, other: Partial<Row> = {}) {
    const context = setup();
    context.service.readOutside = jest.fn(async () =>
      content === null
        ? { unknown: true as const, reason: 'down' }
        : { content, url: URL_, ...other },
    );
    return context;
  }

  it('[KG-2.6] holds when the quote is on the page, and keeps the words as the page has them', async () => {
    const { service } = withPage(
      'Rate limits. EACH key can make 100 requests   per second. Bursts…',
    );

    const [draft] = await service.checkForWrite(WS, [
      { url: `${URL_}#top`, quote: QUOTE },
    ]);

    expect(draft).toMatchObject({
      kind: PageEntryCitationKindEnum.URL,
      targetLabel: URL_,
      snippet: 'EACH key can make 100 requests per second.',
      checkResult: PageEntryCitationCheckEnum.HOLDS,
    });
    expect(draft.checkedAt).toBeInstanceOf(Date);
  });

  it('[KG-2.6] refuses a page with no quote, a quote not on the page, a page that is gone, and an address the server does not read', async () => {
    const { service } = withPage('Nothing about limits here.');

    expect(
      (await refusalOf(service.checkForWrite(WS, [{ url: URL_ }]))).message,
    ).toContain('no quote');
    expect(
      (
        await refusalOf(
          service.checkForWrite(WS, [{ url: URL_, quote: QUOTE }]),
        )
      ).message,
    ).toContain('does not contain the quote');
    expect(
      (
        await refusalOf(
          service.checkForWrite(WS, [
            { url: 'http://docs.vendor.example/', quote: QUOTE },
          ]),
        )
      ).message,
    ).toContain('only an https URL');

    service.readOutside = jest.fn(async () => ({ missing: true as const }));
    expect(
      (
        await refusalOf(
          service.checkForWrite(WS, [{ url: URL_, quote: QUOTE }]),
        )
      ).message,
    ).toContain('is not there');

    service.readOutside = jest.fn(async () => ({
      refused: 'docs.vendor.example resolves to 10.0.0.1',
    }));
    expect(
      (
        await refusalOf(
          service.checkForWrite(WS, [{ url: URL_, quote: QUOTE }]),
        )
      ).message,
    ).toContain('10.0.0.1');
  });

  it('[KG-2.3] gives an UNKNOWN citation that keeps the quote when the page does not answer, and reads it on retry', async () => {
    const { service, db } = withPage(null);

    const [draft] = await service.checkForWrite(WS, [
      { url: URL_, quote: QUOTE },
    ]);

    expect(draft).toMatchObject({
      checkResult: PageEntryCitationCheckEnum.UNKNOWN,
      pendingQuote: QUOTE,
      checkedAt: null,
    });

    const entryId = store(db, [{ ...draft }]);
    service.readOutside = jest.fn(async () => ({
      content: `Limits: ${QUOTE}`,
      url: URL_,
    }));

    expect(await service.retryUnknown(entryId)).toEqual({
      stillUnknown: 0,
      read: 1,
    });
    expect(db.citations[0]).toMatchObject({
      checkResult: 'HOLDS',
      snippet: QUOTE,
      pendingQuote: null,
    });
  });

  it('[KG-2.4] on a new read, holds with a new date while the quote is there, and changed once it is gone', async () => {
    const { service, db } = withPage(`Limits: ${QUOTE}`);
    const entryId = store(db, [
      {
        kind: 'URL',
        targetLabel: URL_,
        snippet: QUOTE,
        checkResult: 'HOLDS',
        checkedAt: WRITTEN,
      },
    ]);

    await service.recheck(entryId);

    expect(db.citations[0].checkResult).toBe('HOLDS');
    expect(db.citations[0].checkedAt.getTime()).toBeGreaterThan(
      WRITTEN.getTime(),
    );

    // Each reading is stored only over an older one.
    db.citations[0].checkedAt = WRITTEN;
    service.readOutside = jest.fn(async () => ({
      content: 'Limits: 50 requests per second.',
      url: URL_,
    }));
    await service.recheck(entryId);

    expect(db.citations[0].checkResult).toBe('CHANGED');

    db.citations[0].checkedAt = WRITTEN;
    service.readOutside = jest.fn(async () => ({ missing: true as const }));
    await service.recheck(entryId);

    expect(db.citations[0].checkResult).toBe('MISSING');
  });

  it('[KG-2.4] keeps the last result when the page does not answer', async () => {
    const { service, db } = withPage(null);
    const entryId = store(db, [
      {
        kind: 'URL',
        targetLabel: URL_,
        snippet: QUOTE,
        checkResult: 'HOLDS',
        checkedAt: WRITTEN,
      },
    ]);

    expect(await service.recheck(entryId)).toEqual({ checked: 0 });
    expect(db.citations[0]).toMatchObject({
      checkResult: 'HOLDS',
      checkedAt: WRITTEN,
    });
  });

  it('queues a new read of each entry in use whose page is 30 days old, once per entry', async () => {
    const { service, db, queue } = setup();
    const findMany = jest.fn(async () => [
      { entryId: 'entry-1' },
      { entryId: 'entry-2' },
    ]);
    (db.prisma as unknown as Row).pageEntryCitation.findMany = findMany;
    const now = new Date('2026-09-28T00:00:00Z');

    expect(await service.recheckObservedLater(now)).toBe(2);

    const [args] = findMany.mock.calls[0] as unknown as [Row];
    expect(args.where.kind).toBe('URL');
    expect(args.where.OR[0].checkedAt.lt).toEqual(
      new Date('2026-08-29T00:00:00Z'),
    );
    expect(args.distinct).toEqual(['entryId']);
    expect(queue.add).toHaveBeenCalledWith(
      'recheckEntryCitations',
      { entryId: 'entry-1' },
      expect.objectContaining({ jobId: 'recheckEntryCitations:entry-1' }),
    );
  });
});

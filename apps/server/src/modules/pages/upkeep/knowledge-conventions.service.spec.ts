/**
 * Conventions from review: findings that keep coming back become a
 * candidate convention a person decides about, and a convention the
 * gardener proposed is switched off when runs given it keep going wrong.
 *
 * Built from the real conventions service and upkeep over an in-memory
 * store that answers the filters they write. Writing an entry, checking a
 * citation, opening an issue and the queue are faked. No network and no
 * model is used.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import {
  PageEntryMaintenanceAction as Action,
  PageEntryMaintenanceReason as Reason,
  PageEntryProposalState as ProposalState,
} from '@prisma/client';
import { UserTypeEnum } from '@vantikhq/types';

import { integrationBotEmail } from 'modules/integration-events/integration-bot';
import { LoggerService } from 'modules/logger/logger.service';

import EntryCitationsService from '../entry-citations.service';
import PageEntriesService from '../page-entries.service';
import { RUN_FINDINGS_JOB } from '../pages.interface';
import PagesService from '../pages.service';
import { findingKey, findingWords } from './findings';
import KnowledgeConventionsService, {
  CONVENTIONS_PAGE_TITLE,
  scopeOf,
} from './knowledge-conventions.service';
import KnowledgeIssues, { KNOWLEDGE_BOT } from './knowledge-issues';
import KnowledgeUpkeepService from './knowledge-upkeep.service';

const WORKSPACE = 'workspace-1';
const DAY = 24 * 60 * 60 * 1000;
const HEAD = (n: number) => `${n}`.repeat(40).slice(0, 40);
const GARDENER_EMAIL = integrationBotEmail(KNOWLEDGE_BOT.slug, WORKSPACE);

/** The same finding, in the words three reviewers used. */
const LOGGER = [
  'Use the logger, not console.log',
  'console.log used instead of the logger',
  'Uses console.log where the logger belongs',
];

// ----------------------------------------------------------------- the store

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') {
      return (condition as Where[]).some((part) => matches(row, part));
    }

    if (key === 'AND') {
      return (condition as Where[]).every((part) => matches(row, part));
    }

    const value = row[key];

    if (condition === null) {
      return value === null || value === undefined;
    }

    if (typeof condition === 'object' && !Array.isArray(condition)) {
      const c = condition as Record<string, unknown>;

      if (['in', 'not', 'gt', 'gte'].some((operator) => operator in c)) {
        return (
          (!('in' in c) || (c.in as unknown[]).includes(value)) &&
          (!('not' in c) || (value ?? null) !== c.not) &&
          (!('gt' in c) || (value != null && compare(value, c.gt) > 0)) &&
          (!('gte' in c) || (value != null && compare(value, c.gte) >= 0))
        );
      }

      return (
        typeof value === 'object' && value !== null && matches(value as Row, c)
      );
    }

    return value === condition;
  });
}

function compare(a: unknown, b: unknown): number {
  return a instanceof Date && b instanceof Date
    ? a.getTime() - b.getTime()
    : String(a).localeCompare(String(b));
}

function byTime(a: Row, b: Row): number {
  return (
    compare(a.createdAt, b.createdAt) ||
    String(a.id).localeCompare(String(b.id))
  );
}

interface RunSeed {
  id: string;
  status?: string;
  deleted?: Date | null;
  repoUrl?: string | null;
  headCommit?: string;
  /** One list of findings per pass. */
  passes: Array<Array<{ message?: unknown; evidence?: unknown }>>;
}

interface Seed {
  runs?: RunSeed[];
  entries?: Row[];
  findings?: Row[];
  maintenance?: Row[];
  signals?: Row[];
  links?: Row[];
  pages?: Row[];
  users?: Row[];
  preferences?: unknown;
  /** Code citations that do not hold at the commit they are read at. */
  unreadable?: string[];
  /** What writing the candidate is refused with, once. */
  refuse?: Error;
}

function harness(seed: Seed = {}) {
  let next = 0;
  let clock = Date.UTC(2026, 8, 1);
  const tick = () => new Date((clock += 1000));

  const modules: Row[] = [
    { id: 'module-api', workspaceId: WORKSPACE, deleted: null, name: 'API' },
    {
      id: 'module-cache',
      workspaceId: WORKSPACE,
      deleted: null,
      name: 'Cache',
    },
    { id: 'module-web', workspaceId: WORKSPACE, deleted: null, name: 'Web' },
    {
      id: 'module-gone',
      workspaceId: WORKSPACE,
      deleted: new Date(),
      name: 'Gone',
    },
  ];
  const repos: Row[] = [
    {
      id: 'repo-api',
      moduleId: 'module-api',
      fullName: 'acme/app',
      pathPrefixes: ['apps/api/'],
      deleted: null,
      createdAt: new Date(1),
    },
    {
      id: 'repo-cache',
      moduleId: 'module-cache',
      fullName: 'acme/app',
      pathPrefixes: ['apps/api/src/cache/'],
      deleted: null,
      createdAt: new Date(2),
    },
    {
      id: 'repo-web',
      moduleId: 'module-web',
      fullName: 'acme/app',
      pathPrefixes: ['apps/web/'],
      deleted: null,
      createdAt: new Date(3),
    },
    {
      id: 'repo-other',
      moduleId: 'module-web',
      fullName: 'acme/other',
      pathPrefixes: [],
      deleted: null,
      createdAt: new Date(4),
    },
  ];
  const runs: Row[] = (seed.runs ?? []).map((run) => ({
    id: run.id,
    workspaceId: WORKSPACE,
    status: run.status ?? 'NEEDS_REVIEW',
    deleted: run.deleted ?? null,
    config:
      run.repoUrl === null
        ? { repoPath: '/tmp/checkout' }
        : { repoUrl: run.repoUrl ?? 'https://github.com/acme/app.git' },
    result: { headCommit: run.headCommit ?? HEAD(1) },
    iterations: run.passes.map((findings, index) => ({
      index: index + 1,
      findings,
    })),
  }));
  const pages = new Map(
    [
      {
        id: 'page-linked',
        workspaceId: WORKSPACE,
        title: 'API notes',
        entryPolicy: 'CURATED',
        deleted: null,
        createdAt: new Date(1),
      } as Row,
      ...(seed.pages ?? []),
    ].map((row) => [row.id as string, row]),
  );
  const links: Row[] = [...(seed.links ?? [])];
  const users: Row[] = [...(seed.users ?? [])];
  const entries = new Map(
    (seed.entries ?? []).map((row) => [
      row.id as string,
      {
        deleted: null,
        verifiedAt: null,
        updatedAt: new Date(clock),
        ...row,
      } as Row,
    ]),
  );
  const findings: Row[] = [...(seed.findings ?? [])];
  const maintenance: Row[] = [...(seed.maintenance ?? [])];
  const signals: Row[] = [...(seed.signals ?? [])];
  const locks: string[] = [];
  const writes: string[] = [];

  const entryView = (row: Row): Row => ({
    // An entry carries its page's workspace, as a row in postgres does.
    workspaceId: (pages.get(row.pageId as string) as Row | undefined)
      ?.workspaceId,
    workspace: { preferences: seed.preferences ?? {} },
    ...row,
    page: {
      ...(pages.get(row.pageId as string) as Row),
      workspace: { preferences: seed.preferences ?? {} },
    },
  });
  const findingView = (row: Row): Row => ({
    ...row,
    agentRun: runs.find((run) => run.id === row.agentRunId) ?? null,
    candidate: row.candidateId
      ? entryView(entries.get(row.candidateId as string) as Row)
      : null,
  });

  const client = {
    workspace: {
      findUnique: jest.fn(async () => ({
        preferences: seed.preferences ?? {},
      })),
    },
    agentRun: {
      findFirst: jest.fn(
        async ({ where }: { where: Where }) =>
          runs.find((run) => matches(run, where)) ?? null,
      ),
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        runs.filter((run) => matches(run, where)),
      ),
    },
    moduleRepo: {
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        repos
          .map((row) => ({
            ...row,
            module: modules.find((m) => m.id === row.moduleId),
          }))
          .filter((row) => matches(row, where))
          .sort(byTime),
      ),
    },
    module: {
      count: jest.fn(
        async ({ where }: { where: Where }) =>
          modules.filter((row) => matches(row, where)).length,
      ),
      findFirst: jest.fn(async ({ where }: { where: Where }) => {
        const found = modules.find((row) => matches(row, where));

        return found
          ? {
              ...found,
              repos: repos
                .filter((row) => row.moduleId === found.id && !row.deleted)
                .sort(byTime),
            }
          : null;
      }),
    },
    knowledgeFinding: {
      createMany: jest.fn(async ({ data }: { data: Row[] }) => {
        let count = 0;

        for (const row of data) {
          if (
            findings.some(
              (f) => f.agentRunId === row.agentRunId && f.key === row.key,
            )
          ) {
            continue;
          }

          findings.push({
            id: `finding-${++next}`,
            createdAt: tick(),
            candidateId: null,
            ...row,
          });
          count++;
        }

        return { count };
      }),
      findMany: jest.fn(
        async ({
          where,
          orderBy,
          take,
        }: {
          where: Where;
          orderBy: Array<Record<string, string>>;
          take: number;
        }) => {
          const hit = findings
            .map(findingView)
            .filter((row) => matches(row, where))
            .sort(byTime);
          const ordered = orderBy[0].createdAt === 'desc' ? hit.reverse() : hit;

          return ordered.slice(0, take);
        },
      ),
      updateMany: jest.fn(
        async ({ where, data }: { where: Where; data: Row }) => {
          const hit = findings.filter((row) => matches(row, where));
          hit.forEach((row) => Object.assign(row, data));

          return { count: hit.length };
        },
      ),
    },
    pageLink: {
      findFirst: jest.fn(
        async ({ where }: { where: Where }) =>
          links
            .map((row) => ({
              ...row,
              page: pages.get(row.pageId as string),
            }))
            .filter((row) => matches(row, where))
            .sort(byTime)[0] ?? null,
      ),
    },
    page: {
      findFirst: jest.fn(
        async ({ where }: { where: Where }) =>
          [...pages.values()].filter((row) => matches(row, where))[0] ?? null,
      ),
    },
    pageEntry: {
      findFirst: jest.fn(
        async ({ where }: { where: Where }) =>
          [...entries.values()]
            .map(entryView)
            .find((row) => matches(row, where)) ?? null,
      ),
      updateMany: jest.fn(
        async ({ where, data }: { where: Where; data: Row }) => {
          const hit = [...entries.values()].filter((row) =>
            matches(entryView(row), where),
          );
          hit.forEach((row) => Object.assign(row, data, { updatedAt: tick() }));

          return { count: hit.length };
        },
      ),
    },
    pageEntrySignal: {
      findMany: jest.fn(
        async ({ where, take }: { where: Where; take?: number }) =>
          signals
            .filter((row) => matches(row, where))
            .sort(byTime)
            .reverse()
            .slice(0, take ?? signals.length),
      ),
    },
    pageEntryMaintenance: {
      count: jest.fn(
        async ({ where }: { where: Where }) =>
          maintenance.filter((row) => matches(row, where)).length,
      ),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row: Row = {
          id: `maintenance-${++next}`,
          createdAt: tick(),
          issueId: null,
          proposalState: null,
          reversedAt: null,
          resolvedAt: null,
          ...data,
        };
        maintenance.push(row);

        return row;
      }),
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        maintenance.filter((row) => matches(row, where)),
      ),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const row = maintenance.find((m) => m.id === where.id);

        return row
          ? {
              ...row,
              entry: entryView(entries.get(row.entryId as string) as Row),
            }
          : null;
      }),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Row }) =>
          Object.assign(
            maintenance.find((m) => m.id === where.id) as Row,
            data,
          ),
      ),
    },
    user: {
      findUnique: jest.fn(
        async ({ where }: { where: { email: string } }) =>
          users.find((row) => row.email === where.email) ?? null,
      ),
      upsert: jest.fn(
        async ({
          where,
          create,
        }: {
          where: { email: string };
          create: Row;
        }) => {
          const found = users.find((row) => row.email === where.email);

          if (found) {
            return found;
          }

          const row = { id: `user-${++next}`, ...create };
          users.push(row);

          return row;
        },
      ),
    },
    usersOnWorkspaces: {
      findUnique: jest.fn(async (): Promise<Row | null> => null),
      upsert: jest.fn(async ({ create }: { create: Row }) => create),
    },
    team: { findMany: jest.fn(async (): Promise<Row[]> => []) },
    $executeRaw: jest.fn(
      async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        locks.push(String(values[0]));
        writes.push(`lock:${String(values[0])}`);

        return 1;
      },
    ),
  };

  const prisma = {
    ...client,
    $transaction: jest.fn(async (work: (tx: typeof client) => unknown) =>
      work(client),
    ),
  };

  let refusal = seed.refuse;
  const createEntry = jest.fn(
    async (
      pageId: string,
      writer: { userId: string; tokenId: string | null },
      input: Row,
    ) => {
      writes.push('createEntry');

      if (refusal) {
        const error = refusal;
        refusal = undefined;
        throw error;
      }

      const id = `entry-${++next}`;
      entries.set(id, {
        id,
        pageId,
        deleted: null,
        status: 'PROPOSED',
        kind: input.kind,
        content: input.content,
        sourceUserId: writer.userId,
        verifiedAt: null,
        updatedAt: tick(),
      });

      return { id };
    },
  );
  const createPage = jest.fn(
    async (workspaceId: string, userId: string, input: Row) => {
      const row: Row = {
        id: `page-${++next}`,
        workspaceId,
        title: input.title,
        entryPolicy: 'CURATED',
        createdById: userId,
        deleted: null,
        createdAt: tick(),
      };
      pages.set(row.id as string, row);

      return row;
    },
  );
  const checkForWrite = jest.fn(
    async (
      _workspaceId: string,
      inputs: Array<Record<string, string>>,
    ): Promise<unknown[]> => {
      const [input] = inputs;

      if ((seed.unreadable ?? []).includes(`${input.path}:${input.lines}`)) {
        throw new BadRequestException(
          `Citation 1 (${input.path}:${input.lines}): lines past the end`,
        );
      }

      return [];
    },
  );
  const open = jest.fn(async () => ({ id: 'issue-1' }));
  const add = jest.fn(async () => ({}));
  const entryChanged = jest.fn(async (): Promise<void> => undefined);

  const upkeep = new KnowledgeUpkeepService(
    prisma as never,
    {} as EntryCitationsService,
    { open } as unknown as KnowledgeIssues,
  );
  const service = new KnowledgeConventionsService(
    prisma as never,
    { createEntry } as unknown as PageEntriesService,
    { createPage } as unknown as PagesService,
    { checkForWrite } as unknown as EntryCitationsService,
    upkeep,
    { open } as unknown as KnowledgeIssues,
    { add } as never,
    { entryChanged } as never,
  );

  return {
    service,
    prisma,
    entries,
    findings,
    maintenance,
    signals: signals as Array<Row & { agentRunId: string }>,
    pages,
    users,
    locks,
    writes,
    createEntry,
    createPage,
    checkForWrite,
    open,
    add,
    entryChanged,
    addRun(run: RunSeed) {
      runs.push({
        id: run.id,
        workspaceId: WORKSPACE,
        status: run.status ?? 'NEEDS_REVIEW',
        deleted: null,
        config: { repoUrl: 'https://github.com/acme/app.git' },
        result: { headCommit: run.headCommit ?? HEAD(1) },
        iterations: run.passes.map((f, index) => ({
          index: index + 1,
          findings: f,
        })),
      });
    },
  };
}

/** A run whose reviewer gave one finding, at a line of a file. */
function reviewed(
  id: string,
  message: string,
  evidence = 'apps/api/src/users.ts:12',
  extra: Partial<RunSeed> = {},
): RunSeed {
  return { id, passes: [[{ message, evidence }]], ...extra };
}

beforeAll(() => {
  jest.spyOn(LoggerService.prototype, 'info').mockImplementation(() => {});
  jest.spyOn(LoggerService.prototype, 'warn').mockImplementation(() => {});
  jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => {});
});

afterAll(() => {
  jest.restoreAllMocks();
});

// ------------------------------------------------------------ recording them

describe('recording what a run’s reviewer found', () => {
  it('[KG-6.3] records each finding once per run, against the module its evidence is in', async () => {
    const secret = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_');
    const t = harness({
      runs: [
        {
          id: 'run-1',
          passes: [
            [
              // Nested modules: the file is the inner one's.
              {
                message: 'Cache keys are built by hand',
                evidence: '/workspace/repo/apps/api/src/cache/keys.ts:40',
              },
              {
                message: `Hard-coded token ${secret} in the client`,
                evidence: `apps/web/src/client.ts:3 holds ${secret}`,
              },
              // Evidence in no module's code, or no words to compare by.
              { message: 'Docs are out of date', evidence: 'README.md:1' },
              { message: 'ok', evidence: 'apps/api/src/a.ts:1' },
              { message: 'No evidence given' },
            ],
            // The same finding on the next pass, however its words are
            // ordered, is not a second one.
            [
              {
                message: 'By hand, cache KEYS are built!',
                evidence: 'apps/api/src/cache/keys.ts:41',
              },
            ],
          ],
        },
      ],
    });

    const result = await t.service.runFinished('run-1');

    expect(result.recorded).toBe(2);
    expect(t.findings).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE,
        moduleId: 'module-cache',
        agentRunId: 'run-1',
        message: 'Cache keys are built by hand',
        words: ['cache', 'keys', 'built', 'hand'],
        key: findingKey('module-cache', findingWords('Cache keys built hand')),
        evidence: '/workspace/repo/apps/api/src/cache/keys.ts:40',
        path: 'apps/api/src/cache/keys.ts',
        line: 40,
        candidateId: null,
      }),
      expect.objectContaining({
        moduleId: 'module-web',
        path: 'apps/web/src/client.ts',
        line: 3,
      }),
    ]);
    // A credential in a reviewer's words is never stored.
    expect(JSON.stringify(t.findings)).not.toContain(secret);
    expect(t.findings[1].message).toContain('[withheld:');

    // Read again, the run records nothing more.
    await t.service.runFinished('run-1');
    expect(t.findings).toHaveLength(2);
  });

  it('[KG-6.3] places a run’s findings in its own repository’s modules, and a checkout’s only when there is one repository', async () => {
    const t = harness({
      runs: [
        // In acme/app this file would be the API's; this run worked in
        // acme/other.
        reviewed('run-other', 'Missing retry on fetch', 'apps/api/fetch.ts:9', {
          repoUrl: 'git@github.com:acme/other.git',
        }),
        reviewed('run-checkout', 'Missing retry on fetch', 'apps/web/x.ts:9', {
          repoUrl: null,
        }),
      ],
    });

    await t.service.runFinished('run-other');
    await t.service.runFinished('run-checkout');

    // acme/other is one module's whole repository; a checkout names no
    // repository, and this workspace has two.
    expect(t.findings.map((f) => [f.agentRunId, f.moduleId])).toEqual([
      ['run-other', 'module-web'],
    ]);
  });

  it('[KG-6.3] reads nothing from a run that was canceled, expired or deleted', async () => {
    const t = harness({
      runs: [
        reviewed('run-canceled', LOGGER[0], undefined, { status: 'CANCELED' }),
        reviewed('run-expired', LOGGER[0], undefined, { status: 'EXPIRED' }),
        reviewed('run-deleted', LOGGER[0], undefined, {
          deleted: new Date(),
        }),
      ],
    });

    for (const id of ['run-canceled', 'run-expired', 'run-deleted']) {
      expect(await t.service.runFinished(id)).toEqual({
        recorded: 0,
        candidates: [],
      });
    }
    expect(t.findings).toHaveLength(0);
  });

  it('[KG-6.3] is queued once per run, and a queue that is down loses the findings, not the run', async () => {
    const t = harness();

    await t.service.findingsLater('run-1');

    expect(t.add).toHaveBeenCalledWith(
      RUN_FINDINGS_JOB,
      { runId: 'run-1' },
      expect.objectContaining({ jobId: `${RUN_FINDINGS_JOB}:run-1` }),
    );

    t.add.mockRejectedValueOnce(new Error('redis is down'));
    await expect(t.service.findingsLater('run-2')).resolves.toBeUndefined();
  });
});

// ------------------------------------------------------ proposing conventions

describe('proposing a convention from findings that keep coming back', () => {
  it('[KG-6.3] writes a candidate convention once three separate runs gave the same finding, and not before', async () => {
    const t = harness({
      runs: [
        // Two findings saying the same in one run count as one run.
        {
          id: 'run-1',
          passes: [
            [
              { message: LOGGER[0], evidence: 'apps/api/src/users.ts:12' },
              { message: LOGGER[1], evidence: 'apps/api/src/teams.ts:30' },
            ],
          ],
        },
        reviewed('run-2', LOGGER[1], 'apps/api/src/teams.ts:30', {
          headCommit: HEAD(2),
        }),
        // Something else in the same module is another finding.
        reviewed('run-3', 'Missing test for the pagination edge case'),
        reviewed('run-4', LOGGER[2], 'apps/api/src/billing.ts:7', {
          headCommit: HEAD(4),
        }),
      ],
    });

    for (const id of ['run-1', 'run-2', 'run-3']) {
      expect((await t.service.runFinished(id)).candidates).toEqual([]);
    }
    expect(t.createEntry).not.toHaveBeenCalled();

    const { candidates } = await t.service.runFinished('run-4');

    expect(candidates).toHaveLength(1);
    expect(t.createEntry).toHaveBeenCalledTimes(1);

    const [pageId, writer, input] = t.createEntry.mock.calls[0];
    const gardener = t.users.find((user) => user.email === GARDENER_EMAIL);

    // As the gardener's bot, a System member: never a person's standing
    // write, so it lands in the inbox and is triaged like an agent's.
    expect(gardener).toMatchObject({ type: UserTypeEnum.System });
    expect(writer).toEqual({ userId: gardener?.id, tokenId: null });
    expect(input).not.toHaveProperty('standing');
    expect(input).toMatchObject({
      kind: 'CONVENTION',
      // Resolves to the module the findings are in.
      scope: 'acme/app/apps/api',
      content:
        'Review found this in 3 separate agent runs on API: ' +
        'console.log used instead of the logger',
    });
    // Every run, newest first, and the code each finding pointed at, read
    // at the commit its run ended at.
    expect(input.citations).toEqual([
      { run: 'run-4' },
      { run: 'run-2' },
      { run: 'run-1' },
      {
        path: 'apps/api/src/billing.ts',
        lines: '7',
        repo: 'acme/app',
        sha: HEAD(4),
      },
      {
        path: 'apps/api/src/teams.ts',
        lines: '30',
        repo: 'acme/app',
        sha: HEAD(2),
      },
      {
        path: 'apps/api/src/users.ts',
        lines: '12',
        repo: 'acme/app',
        sha: HEAD(1),
      },
    ]);
    expect(pageId).toBeDefined();

    // Its findings are linked to it; the other finding waits on its own.
    const linked = t.findings.filter((f) => f.candidateId === candidates[0]);
    expect(linked.map((f) => f.agentRunId).sort()).toEqual([
      'run-1',
      'run-1',
      'run-2',
      'run-4',
    ]);
    expect(
      t.findings.find((f) => f.agentRunId === 'run-3')?.candidateId,
    ).toBeNull();
  });

  it('[KG-6.3] takes the number of runs from the workspace’s settings', async () => {
    const t = harness({
      preferences: { knowledge: { conventionMinRuns: 2 } },
      runs: [reviewed('run-1', LOGGER[0]), reviewed('run-2', LOGGER[1])],
    });

    await t.service.runFinished('run-1');
    expect(t.createEntry).not.toHaveBeenCalled();

    expect((await t.service.runFinished('run-2')).candidates).toHaveLength(1);
  });

  it('[KG-6.3] never writes the same convention twice: later findings join the one already written', async () => {
    const t = harness({
      runs: LOGGER.map((message, i) => reviewed(`run-${i + 1}`, message)),
    });

    for (const id of ['run-1', 'run-2', 'run-3']) {
      await t.service.runFinished(id);
    }
    const [candidate] = [...t.entries.keys()];

    // Three more runs say it again while it waits for a person.
    for (const [i, message] of LOGGER.entries()) {
      t.addRun(reviewed(`run-again-${i}`, message));
      await t.service.runFinished(`run-again-${i}`);
    }

    expect(t.createEntry).toHaveBeenCalledTimes(1);
    expect(t.findings.every((f) => f.candidateId === candidate)).toBe(true);
    // Findings already written up are not looked at again: the lock was
    // taken when the first three runs agreed and when the next three did.
    expect(t.locks).toHaveLength(2);
  });

  it('[KG-6.3] does not count a run deleted since its findings were recorded', async () => {
    const t = harness({
      runs: LOGGER.map((message, i) => reviewed(`run-${i + 1}`, message)),
    });

    await t.service.runFinished('run-1');
    await t.service.runFinished('run-2');
    const run = (await t.prisma.agentRun.findFirst({
      where: { id: 'run-1' },
    })) as Row;
    run.deleted = new Date();

    expect((await t.service.runFinished('run-3')).candidates).toEqual([]);
  });

  it('[KG-6.3] cites at most six of the runs and four places in the code, newest first', async () => {
    const t = harness({
      runs: Array.from({ length: 8 }, (_, i) =>
        reviewed(
          `run-${i + 1}`,
          LOGGER[i % 3],
          `apps/api/src/users.ts:${i + 1}`,
        ),
      ),
      preferences: { knowledge: { conventionMinRuns: 8 } },
    });

    for (let i = 1; i <= 8; i++) {
      await t.service.runFinished(`run-${i}`);
    }

    const citations = t.createEntry.mock.calls[0][2].citations as Array<
      Record<string, string>
    >;
    expect(citations.filter((c) => c.run).map((c) => c.run)).toEqual([
      'run-8',
      'run-7',
      'run-6',
      'run-5',
      'run-4',
      'run-3',
    ]);
    expect(citations.filter((c) => c.path).map((c) => c.lines)).toEqual([
      '8',
      '7',
      '6',
      '5',
    ]);
    expect(t.createEntry.mock.calls[0][2].content).toContain('8 separate');
  });

  it('[KG-6.3] does not propose again soon after a person turned it down, and does after the decay window', async () => {
    const t = harness({
      entries: [
        {
          id: 'rejected',
          pageId: 'page-linked',
          status: 'ARCHIVED',
          kind: 'CONVENTION',
          updatedAt: new Date(Date.now() - 10 * DAY),
        },
        {
          id: 'long-ago',
          pageId: 'page-linked',
          status: 'ARCHIVED',
          kind: 'CONVENTION',
          updatedAt: new Date(Date.now() - 120 * DAY),
        },
      ],
      findings: [
        {
          id: 'old-1',
          workspaceId: WORKSPACE,
          moduleId: 'module-api',
          agentRunId: 'run-old',
          words: findingWords(LOGGER[0]),
          candidateId: 'rejected',
          createdAt: new Date(1),
        },
        {
          id: 'old-2',
          workspaceId: WORKSPACE,
          moduleId: 'module-api',
          agentRunId: 'run-old',
          words: findingWords('Missing test for the pagination edge case'),
          candidateId: 'long-ago',
          createdAt: new Date(2),
        },
      ],
      runs: [
        ...LOGGER.map((message, i) => reviewed(`run-${i + 1}`, message)),
        ...[4, 5, 6].map((i) =>
          reviewed(`run-${i}`, 'Missing test for the pagination edge case'),
        ),
      ],
    });

    for (const i of [1, 2, 3, 4, 5, 6]) {
      await t.service.runFinished(`run-${i}`);
    }

    // Rejected ten days ago: its findings join it. Rejected four months
    // ago: asked again.
    expect(t.createEntry).toHaveBeenCalledTimes(1);
    expect(t.createEntry.mock.calls[0][2].content).toContain('pagination');
    expect(
      t.findings
        .filter((f) =>
          ['run-1', 'run-2', 'run-3'].includes(f.agentRunId as string),
        )
        .every((f) => f.candidateId === 'rejected'),
    ).toBe(true);
  });

  it('[KG-6.3] [KG-7.4] joins findings to a convention folded into its page’s body however long ago, which is still served', async () => {
    const t = harness({
      entries: [
        {
          id: 'folded',
          pageId: 'page-linked',
          status: 'CONSOLIDATED',
          kind: 'CONVENTION',
          updatedAt: new Date(Date.now() - 200 * DAY),
        },
      ],
      findings: [
        {
          id: 'old-1',
          workspaceId: WORKSPACE,
          moduleId: 'module-api',
          agentRunId: 'run-old',
          words: findingWords(LOGGER[0]),
          candidateId: 'folded',
          createdAt: new Date(1),
        },
      ],
      runs: LOGGER.map((message, i) => reviewed(`run-${i + 1}`, message)),
    });

    for (const i of [1, 2, 3]) {
      await t.service.runFinished(`run-${i}`);
    }

    // Still in use: nothing is written again, and the findings join it.
    expect(t.createEntry).not.toHaveBeenCalled();
    expect(
      t.findings
        .filter((f) =>
          ['run-1', 'run-2', 'run-3'].includes(f.agentRunId as string),
        )
        .every((f) => f.candidateId === 'folded'),
    ).toBe(true);
  });

  it('[KG-6.3] leaves out code that does not hold where its run ended, rather than refusing the candidate', async () => {
    const t = harness({
      unreadable: ['apps/api/src/users.ts:12'],
      runs: LOGGER.map((message, i) =>
        reviewed(`run-${i + 1}`, message, `apps/api/src/users.ts:${12 + i}`, {
          headCommit: i === 1 ? 'not-a-commit' : HEAD(1),
        }),
      ),
    });

    for (const id of ['run-1', 'run-2', 'run-3']) {
      await t.service.runFinished(id);
    }

    const code = (
      t.createEntry.mock.calls[0][2].citations as Array<Record<string, string>>
    ).filter((citation) => citation.path);

    expect(code).toEqual([
      {
        path: 'apps/api/src/users.ts',
        lines: '14',
        repo: 'acme/app',
        sha: HEAD(1),
      },
      // A head that is not a commit id is not read at; the default branch is.
      { path: 'apps/api/src/users.ts', lines: '13', repo: 'acme/app' },
    ]);
  });

  it('[KG-6.3] links the findings to what the page already holds when the write is refused as a repeat', async () => {
    const t = harness({
      refuse: new ConflictException({
        message: 'already has this',
        nearMatches: [{ entryId: 'entry-known' }],
      }),
      runs: LOGGER.map((message, i) => reviewed(`run-${i + 1}`, message)),
    });

    for (const id of ['run-1', 'run-2', 'run-3']) {
      await t.service.runFinished(id);
    }

    expect(t.findings.every((f) => f.candidateId === 'entry-known')).toBe(true);
  });

  it('[KG-6.3] tries again at the next run when the write is refused for another reason', async () => {
    const t = harness({
      refuse: new ForbiddenException('too many entries waiting'),
      runs: [
        ...LOGGER.map((message, i) => reviewed(`run-${i + 1}`, message)),
        reviewed('run-4', LOGGER[0]),
      ],
    });

    for (const id of ['run-1', 'run-2', 'run-3']) {
      await t.service.runFinished(id);
    }
    expect(t.findings.every((f) => f.candidateId === null)).toBe(true);

    await t.service.runFinished('run-4');
    expect(t.createEntry).toHaveBeenCalledTimes(2);
    expect(t.findings.every((f) => f.candidateId)).toBe(true);
  });

  it('[KG-6.3] fails the job on anything else, so it is tried again', async () => {
    const t = harness({
      refuse: new Error('connection reset'),
      runs: LOGGER.map((message, i) => reviewed(`run-${i + 1}`, message)),
    });

    await t.service.runFinished('run-1');
    await t.service.runFinished('run-2');
    await expect(t.service.runFinished('run-3')).rejects.toThrow(
      'connection reset',
    );
    expect(t.findings.every((f) => f.candidateId === null)).toBe(true);

    // So does a citation check that fails for a reason other than the code.
    t.checkForWrite.mockRejectedValueOnce(new Error('rate limited'));
    await expect(t.service.propose(WORKSPACE, 'module-api')).rejects.toThrow(
      'rate limited',
    );
    expect(t.findings.every((f) => f.candidateId === null)).toBe(true);
  });

  it('[KG-6.3] writes under the workspace’s lock, and reads the findings again once it holds it', async () => {
    const t = harness({
      runs: LOGGER.map((message, i) => reviewed(`run-${i + 1}`, message)),
    });

    for (const id of ['run-1', 'run-2']) {
      await t.service.runFinished(id);
    }
    expect(t.locks).toEqual([]);

    // Another writer links the findings while this one waits for the lock.
    t.entries.set('written', {
      id: 'written',
      pageId: 'page-linked',
      status: 'PROPOSED',
      deleted: null,
      updatedAt: new Date(),
    });
    t.prisma.$executeRaw.mockImplementationOnce(async () => {
      t.findings.forEach((f) => Object.assign(f, { candidateId: 'written' }));
      t.locks.push('knowledge-conventions:workspace-1');
      return 1;
    });
    await t.service.runFinished('run-3');

    expect(t.locks).toEqual([`knowledge-conventions:${WORKSPACE}`]);
    expect(t.createEntry).not.toHaveBeenCalled();
  });

  it('[KG-6.3] writes nothing for a module since deleted', async () => {
    const t = harness({
      findings: [1, 2, 3].map((i) => ({
        id: `gone-${i}`,
        workspaceId: WORKSPACE,
        moduleId: 'module-gone',
        agentRunId: `run-${i}`,
        words: findingWords(LOGGER[0]),
        candidateId: null as string | null,
        createdAt: new Date(i),
      })),
      runs: [1, 2, 3].map((i) => reviewed(`run-${i}`, 'unrelated words here')),
    });

    expect(await t.service.propose(WORKSPACE, 'module-gone')).toEqual([]);
    expect(t.createEntry).not.toHaveBeenCalled();
    expect(t.locks).toEqual([]);
  });

  it('[KG-6.3] writes on the page linked to the module, else on one page of conventions it makes once', async () => {
    const linked = harness({
      links: [
        {
          id: 'link-1',
          pageId: 'page-linked',
          entityType: 'MODULE',
          entityId: 'module-api',
          deleted: null,
          createdAt: new Date(1),
        },
      ],
      runs: LOGGER.map((message, i) => reviewed(`run-${i + 1}`, message)),
    });

    for (const id of ['run-1', 'run-2', 'run-3']) {
      await linked.service.runFinished(id);
    }
    expect(linked.createEntry.mock.calls[0][0]).toBe('page-linked');
    expect(linked.createPage).not.toHaveBeenCalled();

    const own = harness({
      pages: [
        {
          id: 'page-locked',
          workspaceId: WORKSPACE,
          title: 'Locked',
          entryPolicy: 'LOCKED',
          deleted: null,
        },
      ],
      links: [
        {
          id: 'link-locked',
          pageId: 'page-locked',
          entityType: 'MODULE',
          entityId: 'module-api',
          deleted: null,
          createdAt: new Date(1),
        },
      ],
      runs: [
        ...LOGGER.map((message, i) => reviewed(`run-${i + 1}`, message)),
        ...[4, 5, 6].map((i) =>
          reviewed(`run-${i}`, 'Missing test for the pagination edge case'),
        ),
      ],
    });

    for (const i of [1, 2, 3, 4, 5, 6]) {
      await own.service.runFinished(`run-${i}`);
    }

    // A locked page is kept by hand: the gardener makes its own page, once.
    expect(own.createPage).toHaveBeenCalledTimes(1);
    expect(own.createPage.mock.calls[0][2]).toMatchObject({
      title: CONVENTIONS_PAGE_TITLE,
    });
    const made = own.createPage.mock.results[0].value as Promise<Row>;
    const page = await made;
    expect(own.createEntry.mock.calls.map((call) => call[0])).toEqual([
      page.id,
      page.id,
    ]);
  });

  it('[KG-6.3] scopes a candidate to the folder most of its findings are in, or the whole repository', () => {
    const repos = [
      { fullName: 'acme/app', pathPrefixes: ['apps/api/', 'libs/shared'] },
      { fullName: 'Acme/Tools', pathPrefixes: [] },
    ];
    const app = (path: string) => ({ repo: 'acme/app', path });

    expect(
      scopeOf(repos, [
        app('libs/shared/a.ts'),
        app('libs/shared/b.ts'),
        app('apps/api/c.ts'),
      ]),
    ).toBe('acme/app/libs/shared');
    // The whole of another repository holds none of this one's files.
    expect(
      scopeOf(repos, [
        app('apps/api/c.ts'),
        { repo: 'acme/tools', path: 'bin/x.ts' },
        { repo: 'acme/tools', path: 'bin/y.ts' },
      ]),
    ).toBe('Acme/Tools');
    // A checkout's finding counts wherever its path fits.
    expect(scopeOf(repos, [{ repo: null, path: 'apps/api/c.ts' }])).toBe(
      'acme/app/apps/api',
    );
  });
});

// -------------------------------------------------------- switching them off

describe('switching off a convention runs keep going wrong with', () => {
  function weighing(
    overrides: {
      entry?: Row;
      signals?: Array<[string, number, number?]>;
      maintenance?: Row[];
      preferences?: unknown;
      gardener?: boolean;
    } = {},
  ) {
    const gardener = { id: 'user-gardener', email: GARDENER_EMAIL };

    return harness({
      users: overrides.gardener === false ? [] : [gardener],
      preferences: overrides.preferences,
      entries: [
        {
          id: 'convention',
          pageId: 'page-linked',
          status: 'STANDING',
          kind: 'CONVENTION',
          content:
            'Review found this in 3 separate agent runs on API: use the logger',
          moduleIds: ['module-api'],
          sourceUserId: 'user-gardener',
          ...overrides.entry,
        },
      ],
      signals: (overrides.signals ?? []).map(([kind, weight, day], i) => ({
        id: `signal-${i}`,
        entryId: 'convention',
        agentRunId: `run-${i}`,
        kind,
        weight,
        evidence:
          kind === 'HARMFUL' ? `review finding at apps/api/x.ts:${i}` : null,
        createdAt: new Date(Date.UTC(2026, 7, day ?? 1 + i)),
      })),
      maintenance: overrides.maintenance,
    });
  }

  const harm = (n: number): Array<[string, number]> =>
    Array.from({ length: n }, () => ['HARMFUL', 1] as [string, number]);

  it('[KG-6.3] archives a convention it proposed once harm outnumbers help by the margin, with the counts as its reason', async () => {
    const t = weighing({
      signals: [...harm(4), ['HELPFUL', 1], ['HARMFUL', 0.5], ['HELPFUL', 0.5]],
    });

    expect(await t.service.weigh('convention')).toBe('ARCHIVED');

    expect(t.entries.get('convention')?.status).toBe('ARCHIVED');
    expect(t.maintenance).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE,
        entryId: 'convention',
        action: Action.ARCHIVED,
        reason: Reason.HARMFUL_SIGNALS,
        proposalState: null,
        evidence: { harmful: 4.5, helpful: 1.5, margin: 3, since: null },
        issueId: 'issue-1',
      }),
    ]);
    expect(t.entryChanged).toHaveBeenCalledWith('convention');

    // The module's team is told, with what the harmful outcomes pointed at.
    expect(t.open).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE,
        moduleIds: ['module-api'],
        title: expect.stringContaining('A convention was switched off'),
        markdown: expect.stringContaining('review finding at apps/api/x.ts:0'),
      }),
    );
  });

  it('[KG-6.3] leaves it in use short of the margin, which the workspace may set', async () => {
    expect(
      await weighing({ signals: [...harm(4), ['HELPFUL', 1.5]] }).service.weigh(
        'convention',
      ),
    ).toBeNull();

    const wider = weighing({
      signals: harm(4),
      preferences: { knowledge: { conventionHarmMargin: 5 } },
    });
    expect(await wider.service.weigh('convention')).toBeNull();
    expect(wider.entries.get('convention')?.status).toBe('STANDING');

    const narrower = weighing({
      signals: harm(1),
      preferences: { knowledge: { conventionHarmMargin: 1 } },
    });
    expect(await narrower.service.weigh('convention')).toBe('ARCHIVED');
  });

  it('[KG-6.3] counts only what came after a person put it back', async () => {
    const t = weighing({
      // Five harmful outcomes before the person put it back, two since.
      signals: [
        ...[1, 2, 3, 4, 5].map((day): [string, number, number] => [
          'HARMFUL',
          1,
          day,
        ]),
        ['HARMFUL', 1, 20],
        ['HARMFUL', 1, 21],
      ],
      maintenance: [
        {
          id: 'undone',
          entryId: 'convention',
          action: Action.ARCHIVED,
          reason: Reason.HARMFUL_SIGNALS,
          proposalState: null,
          reversedAt: new Date(Date.UTC(2026, 7, 10)),
          resolvedAt: null,
        },
      ],
    });

    expect(await t.service.weigh('convention')).toBeNull();
    expect(t.entries.get('convention')?.status).toBe('STANDING');
  });

  it('[KG-6.3] asks a person instead for a verified convention, or one on a locked page, and asks once', async () => {
    const verified = weighing({
      signals: harm(3),
      entry: { verifiedAt: new Date() },
    });

    expect(await verified.service.weigh('convention')).toBe('PROPOSED');
    expect(await verified.service.weigh('convention')).toBeNull();
    expect(verified.entries.get('convention')?.status).toBe('STANDING');
    expect(verified.maintenance).toEqual([
      expect.objectContaining({
        action: Action.ARCHIVE_PROPOSED,
        reason: Reason.HARMFUL_SIGNALS,
        proposalState: ProposalState.OPEN,
        evidence: { harmful: 3, helpful: 0, margin: 3, since: null },
      }),
    ]);
    expect(verified.open).not.toHaveBeenCalled();

    const locked = weighing({
      signals: harm(3),
      entry: { pageId: 'page-locked' },
    });
    locked.pages.set('page-locked', {
      id: 'page-locked',
      workspaceId: WORKSPACE,
      entryPolicy: 'LOCKED',
      deleted: null,
    });
    expect(await locked.service.weigh('convention')).toBe('PROPOSED');
    expect(locked.entries.get('convention')?.status).toBe('STANDING');
  });

  it('[KG-6.3] [KG-7.4] weighs a convention folded into its page’s body, which is still served, and asks a person rather than archive it alone', async () => {
    const t = weighing({
      signals: harm(3),
      entry: { status: 'CONSOLIDATED' },
    });

    // A person folded it into the page, whose body still says it: they are
    // asked, once, and nothing is taken out of use meanwhile.
    expect(await t.service.weigh('convention')).toBe('PROPOSED');
    expect(await t.service.weigh('convention')).toBeNull();
    expect(t.entries.get('convention')?.status).toBe('CONSOLIDATED');
    expect(t.maintenance).toEqual([
      expect.objectContaining({
        entryId: 'convention',
        action: Action.ARCHIVE_PROPOSED,
        reason: Reason.HARMFUL_SIGNALS,
        proposalState: ProposalState.OPEN,
        evidence: { harmful: 3, helpful: 0, margin: 3, since: null },
      }),
    ]);
    expect(t.open).not.toHaveBeenCalled();

    // Short of the margin, it is left as it is.
    const fine = weighing({
      signals: [...harm(3), ['HELPFUL', 1]],
      entry: { status: 'CONSOLIDATED' },
    });
    expect(await fine.service.weigh('convention')).toBeNull();
    expect(fine.maintenance).toEqual([]);
  });

  it('[KG-6.3] counts from a person’s decline, so a declined proposal is not asked again on old outcomes', async () => {
    // Declined long enough ago that the queue's quiet period is over: only
    // the counting keeps the old outcomes from asking again.
    const declined = (resolvedAt: Date): Row => ({
      id: 'declined',
      entryId: 'convention',
      action: Action.ARCHIVE_PROPOSED,
      reason: Reason.HARMFUL_SIGNALS,
      proposalState: ProposalState.DECLINED,
      resolvedAt,
      reversedAt: null,
    });
    const before = Date.now() - 200 * DAY;
    const signals = harm(3).map(([k, w], i): [string, number, number] => [
      k,
      w,
      i + 1,
    ]);
    const t = weighing({
      signals,
      entry: { verifiedAt: new Date() },
      maintenance: [declined(new Date(before + 50 * DAY))],
    });
    // The outcomes came before the decline.
    for (const signal of t.signals) {
      signal.createdAt = new Date(before + Number(signal.agentRunId.slice(4)));
    }

    expect(await t.service.weigh('convention')).toBeNull();
    expect(t.maintenance).toHaveLength(1);

    // Outcomes after it count.
    const later = weighing({
      signals,
      entry: { verifiedAt: new Date() },
      maintenance: [declined(new Date(before))],
    });
    for (const signal of later.signals) {
      signal.createdAt = new Date(before + DAY);
    }
    expect(await later.service.weigh('convention')).toBe('PROPOSED');
  });

  it('[KG-6.3] switches off only a standing convention the gardener wrote', async () => {
    const cases: Array<Parameters<typeof weighing>[0]> = [
      // A person's convention is theirs to retire.
      { entry: { sourceUserId: 'person-1' } },
      // No gardener in the workspace: nothing it wrote.
      { gardener: false },
      // Still waiting for a person: it has been handed to no run.
      { entry: { status: 'PROPOSED' } },
      // Not a convention.
      { entry: { kind: 'FACT' } },
    ];

    for (const overrides of cases) {
      const t = weighing({ ...overrides, signals: harm(5) });

      expect(await t.service.weigh('convention')).toBeNull();
      expect(t.maintenance).toEqual([]);
      expect(t.entries.get('convention')?.status).toBe(
        overrides?.entry?.status ?? 'STANDING',
      );
    }
  });

  it('[KG-6.3] archives nothing when the entry moved on while it was weighed', async () => {
    const t = weighing({ signals: harm(3) });
    const read = t.prisma.pageEntry.findFirst.getMockImplementation();

    t.prisma.pageEntry.findFirst.mockImplementationOnce(async (args) => {
      const found = await read?.(args);
      // A person verifies it before the archive is written.
      Object.assign(t.entries.get('convention') as Row, {
        verifiedAt: new Date(),
      });
      return found;
    });

    expect(await t.service.weigh('convention')).toBeNull();
    expect(t.entries.get('convention')?.status).toBe('STANDING');
    expect(t.maintenance).toEqual([]);
  });
});

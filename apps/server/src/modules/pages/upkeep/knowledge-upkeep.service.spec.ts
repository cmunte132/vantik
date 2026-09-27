/**
 * Keeping knowledge true as the code changes: what a change that landed on a
 * default branch does to the entries citing the files it touched.
 *
 * Built from the real citation checks, upkeep and issue opener over an
 * in-memory store that answers the filters they write, with the repository,
 * the judge and the issue service faked. No network and no model is used.
 */
import {
  PageEntryMaintenanceAction as Action,
  PageEntryMaintenanceReason as Reason,
  PageEntryProposalState as ProposalState,
  WorkflowCategory,
} from '@prisma/client';
import {
  PageEntryCitationCheckEnum as Check,
  PageEntryCitationJudgmentEnum as Judgment,
  PageEntryStatusEnum as Status,
} from '@vantikhq/types';

import { LoggerService } from 'modules/logger/logger.service';

import CitationJudge from '../citation-judge';
import EntryCitationsService from '../entry-citations.service';
import { type CodeLandedJob } from '../pages.interface';
import KnowledgeIssues, {
  KNOWLEDGE_BOT,
  KNOWLEDGE_LABEL,
} from './knowledge-issues';
import KnowledgeUpkeepService, {
  UnreadCitations,
} from './knowledge-upkeep.service';

const WORKSPACE = 'workspace-1';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const NEWER = 'f'.repeat(40);
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

const ORIGINAL = [
  'export function retry() {',
  '  const attempts = 3;',
  '  return attempts;',
  '}',
  '',
].join('\n');
const MOVED = `// Retries.\n// See the runbook.\n${ORIGINAL}`;
const CHANGED = ORIGINAL.replace('attempts = 3', 'attempts = 5');

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

      if ('none' in c) {
        return !(value as Row[]).some((each) => matches(each, c.none as Where));
      }

      if (
        ['in', 'not', 'lt', 'gte', 'hasSome'].some((operator) => operator in c)
      ) {
        return (
          (!('in' in c) || (c.in as unknown[]).includes(value)) &&
          (!('not' in c) || (value ?? null) !== c.not) &&
          (!('lt' in c) || (value !== null && compare(value, c.lt) < 0)) &&
          (!('gte' in c) || (value != null && compare(value, c.gte) >= 0)) &&
          (!('hasSome' in c) ||
            (c.hasSome as unknown[]).some((id) =>
              (value as unknown[]).includes(id),
            ))
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

interface Seed {
  entries?: Row[];
  citations?: Row[];
  maintenance?: Row[];
  pages?: Row[];
  modules?: Row[];
  teams?: Row[];
  issueCounts?: Array<{ teamId: string; count: number }>;
}

function harness(seed: Seed = {}) {
  const pages = new Map(
    [
      {
        id: 'page-1',
        workspaceId: WORKSPACE,
        title: 'Retries',
        entryPolicy: 'CURATED',
        deleted: null,
      } as Row,
      ...(seed.pages ?? []),
    ].map((row) => [row.id as string, row]),
  );
  const teams: Row[] = seed.teams ?? [
    {
      id: 'team-old',
      workspaceId: WORKSPACE,
      deleted: null,
      createdAt: new Date(1),
    },
    {
      id: 'team-owner',
      workspaceId: WORKSPACE,
      deleted: null,
      createdAt: new Date(2),
    },
  ];
  const modules: Row[] = seed.modules ?? [
    {
      id: 'module-api',
      workspaceId: WORKSPACE,
      deleted: null,
      ownerTeamId: 'team-owner',
      linkedTeamIds: [],
    },
  ];
  const repos: Row[] = [
    {
      id: 'repo-row-1',
      moduleId: 'module-api',
      externalRepoId: 'gh-1',
      integrationAccountId: 'account-1',
      fullName: 'acme/api',
      deleted: null,
    },
    {
      id: 'repo-row-2',
      moduleId: 'module-api',
      externalRepoId: 'gh-2',
      integrationAccountId: 'account-1',
      fullName: 'acme/web',
      deleted: null,
    },
  ];
  const workflows: Row[] = teams.flatMap((team): Row[] => [
    {
      id: `${team.id}-backlog`,
      teamId: team.id,
      category: WorkflowCategory.BACKLOG,
      position: 0,
      deleted: null,
    },
    {
      id: `${team.id}-triage`,
      teamId: team.id,
      category: WorkflowCategory.TRIAGE,
      position: 1,
      deleted: null,
    },
  ]);
  const entries = new Map(
    (seed.entries ?? []).map((row) => [row.id as string, row]),
  );
  const citations: Row[] = [...(seed.citations ?? [])];
  const maintenance: Row[] = [...(seed.maintenance ?? [])];
  const labels: Row[] = [];
  const users: Row[] = [];
  const members: Row[] = [];
  const issues: Row[] = [];
  let next = 0;

  const moduleView = (id: unknown) => modules.find((row) => row.id === id);
  const repoView = (row: Row): Row => ({
    ...row,
    module: moduleView(row.moduleId),
  });
  const entryView = (row: Row): Row => ({
    ...row,
    page: pages.get(row.pageId as string),
    citations: citations.filter((c) => c.entryId === row.id),
  });
  const citationView = (row: Row): Row => {
    const repo = repos.find((candidate) => candidate.id === row.moduleRepoId);

    return {
      ...row,
      entry: entryView(entries.get(row.entryId as string) as Row),
      moduleRepo: repo ? repoView(repo) : null,
    };
  };
  const maintenanceView = (row: Row): Row => ({
    ...row,
    entry: entryView(entries.get(row.entryId as string) as Row),
  });

  const client = {
    moduleRepo: {
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        repos.map(repoView).filter((row) => matches(row, where)),
      ),
      findFirst: jest.fn(
        async ({ where }: { where: Where }) =>
          repos.map(repoView).find((row) => matches(row, where)) ?? null,
      ),
    },
    pageEntryCitation: {
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        citations.map(citationView).filter((row) => matches(row, where)),
      ),
      update: jest.fn(
        async ({ where, data }: { where: { id: string }; data: Row }) => {
          const row = citations.find((c) => c.id === where.id) as Row;
          Object.assign(row, data);

          return row;
        },
      ),
    },
    pageEntry: {
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        [...entries.values()]
          .map(entryView)
          .filter((row) => matches(row, where)),
      ),
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
          hit.forEach((row) => Object.assign(row, data));

          return { count: hit.length };
        },
      ),
    },
    pageEntryMaintenance: {
      count: jest.fn(
        async ({ where }: { where: Where }) =>
          maintenance.map(maintenanceView).filter((row) => matches(row, where))
            .length,
      ),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row: Row = {
          id: `maintenance-${++next}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          issueId: null,
          proposalState: null,
          reversedAt: null,
          ...data,
        };
        maintenance.push(row);

        return row;
      }),
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        maintenance.map(maintenanceView).filter((row) => matches(row, where)),
      ),
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) =>
          maintenance.map(maintenanceView).find((row) => row.id === where.id) ??
          null,
      ),
      updateMany: jest.fn(
        async ({ where, data }: { where: Where; data: Row }) => {
          const hit = maintenance.filter((row) => matches(row, where));
          hit.forEach((row) => Object.assign(row, data));

          return { count: hit.length };
        },
      ),
    },
    agentRun: { findFirst: jest.fn(async (): Promise<Row | null> => null) },
    team: {
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        teams.filter((row) => matches(row, where)),
      ),
      findFirst: jest.fn(
        async ({ where }: { where: Where }) =>
          teams
            .filter((row) => matches(row, where))
            .sort((a, b) => compare(a.createdAt, b.createdAt))[0] ?? null,
      ),
    },
    module: {
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        modules.filter((row) => matches(row, where)),
      ),
    },
    workflow: {
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        workflows
          .filter((row) => matches(row, where))
          .sort((a, b) => (a.position as number) - (b.position as number)),
      ),
    },
    issue: {
      groupBy: jest.fn(async () =>
        [...(seed.issueCounts ?? [])]
          .sort((a, b) => b.count - a.count)
          .slice(0, 1)
          .map(({ teamId, count }) => ({ teamId, _count: { _all: count } })),
      ),
    },
    label: {
      upsert: jest.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { name_workspaceId: { name: string; workspaceId: string } };
          create: Row;
          update: Row;
        }) => {
          const found = labels.find(
            (row) =>
              row.name === where.name_workspaceId.name &&
              row.workspaceId === where.name_workspaceId.workspaceId,
          );

          if (found) {
            return Object.assign(found, update);
          }

          const row = { id: `label-${++next}`, ...create };
          labels.push(row);

          return row;
        },
      ),
    },
    user: {
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
      upsert: jest.fn(async ({ create }: { create: Row }) => {
        members.push(create);

        return create;
      }),
    },
  };

  // A transaction that throws leaves the store as it found it.
  const prisma = {
    ...client,
    $transaction: jest.fn(async (work: (tx: typeof client) => unknown) => {
      const saved = {
        entries: [...entries.values()].map((row) => ({ ...row })),
        citations: citations.map((row) => ({ ...row })),
        maintenance: maintenance.map((row) => ({ ...row })),
      };

      try {
        return await work(client);
      } catch (error) {
        saved.entries.forEach((row) =>
          Object.assign(entries.get(row.id as string) as Row, row),
        );
        citations.splice(0, citations.length, ...saved.citations);
        maintenance.splice(0, maintenance.length, ...saved.maintenance);
        throw error;
      }
    }),
  };

  // The repository: one head, one file per path; null is a removed file.
  const repo = {
    head: { sha: SHA } as { sha: string } | { unknown: true; reason: string },
    code: { 'src/retry.ts': ORIGINAL } as Record<string, string | null>,
    tooLarge: new Set<string>(),
  };
  const reads: Array<{ path: string; ref: string }> = [];
  const files = {
    head: jest.fn(async () => repo.head),
    read: jest.fn(async (_repo: unknown, path: string, ref: string) => {
      reads.push({ path, ref });

      if (repo.tooLarge.has(path)) {
        return { unknown: true, reason: 'too large', thisFileOnly: true };
      }

      const content = repo.code[path];

      return content === null || content === undefined
        ? { missing: true }
        : { content };
    }),
  };
  const judge = {
    judge: jest.fn(async () => ({
      verdict: Judgment.CONTRADICTED,
      model: 'judge-model',
      lines: '2-2',
      reason: 'The code now makes five attempts, not three.',
    })),
  };
  const issueService = {
    createIssueAPI: jest.fn(async (dto: Row, userId: string) => {
      const row = { id: `issue-${++next}`, ...dto, createdById: userId };
      issues.push(row);

      return row;
    }),
  };

  const build = (withJudge: unknown = judge) => {
    const entryCitations = new EntryCitationsService(
      prisma as never,
      files as never,
      withJudge as never,
    );

    return new KnowledgeUpkeepService(
      prisma as never,
      entryCitations,
      new KnowledgeIssues(prisma as never, issueService as never),
    );
  };

  return {
    prisma,
    entries,
    citations,
    maintenance,
    labels,
    users,
    issues,
    repo,
    reads,
    files,
    judge,
    issueService,
    upkeep: build(),
    build,
  };
}

// ------------------------------------------------------------------ fixtures

function entry(id: string, overrides: Row = {}): Row {
  return {
    id,
    pageId: 'page-1',
    content: `Retries make three attempts (${id}).`,
    status: Status.STANDING,
    deleted: null,
    verifiedAt: null,
    sourceSession: null,
    moduleIds: ['module-api'],
    ...overrides,
  };
}

function citation(id: string, entryId: string, overrides: Row = {}): Row {
  return {
    id,
    entryId,
    kind: 'CODE',
    moduleRepoId: 'repo-row-1',
    path: 'src/retry.ts',
    commitSha: 'c'.repeat(40),
    startLine: 2,
    endLine: 2,
    snippet: 'const attempts = 3;',
    targetId: null,
    checkedAt: new Date(Date.now() - 30 * DAY),
    checkedSha: 'c'.repeat(40),
    checkResult: Check.HOLDS,
    pendingQuote: null,
    judgment: null,
    ...overrides,
  };
}

function landed(changedPaths = ['src/retry.ts']): CodeLandedJob {
  return {
    workspaceId: WORKSPACE,
    externalRepoId: 'gh-1',
    sha: SHA,
    changedPaths,
  };
}

/** When the job for a change was queued: just now, before it runs. */
const queued = () => new Date(Date.now() - MINUTE);

// --------------------------------------------------------------------- tests

describe('a change that landed re-checks the citations it touches', () => {
  it('[KG-6.2] reads each cited file the change touched at the commit it landed as, and refreshes a citation that holds', async () => {
    const t = harness({
      entries: [entry('e1'), entry('e2'), entry('e3')],
      citations: [
        citation('c1', 'e1'),
        citation('c2', 'e2', { path: 'src/other.ts' }),
        citation('c3', 'e3', { moduleRepoId: 'repo-row-2' }),
      ],
    });
    const before = Date.now();

    const summary = await t.upkeep.codeLanded(
      landed(['src/retry.ts', 'README.md']),
      queued(),
    );

    expect(t.reads).toEqual([{ path: 'src/retry.ts', ref: SHA }]);
    expect(t.citations[0]).toMatchObject({
      checkResult: Check.HOLDS,
      checkedSha: SHA,
      startLine: 2,
      endLine: 2,
    });
    expect((t.citations[0].checkedAt as Date).getTime()).toBeGreaterThanOrEqual(
      before,
    );
    // A file the change did not touch, and the same path in another
    // repository, are not read.
    expect(t.citations[1].checkedSha).toBe('c'.repeat(40));
    expect(t.citations[2].checkedSha).toBe('c'.repeat(40));
    expect(t.entries.get('e1')?.status).toBe(Status.STANDING);
    expect(t.maintenance).toEqual([]);
    expect(t.issues).toEqual([]);
    expect(summary).toMatchObject({ checked: 1, disputed: 0, proposed: 0 });
  });

  it('[KG-6.2] reads the head instead when newer commits have landed since, as it contains the change', async () => {
    const t = harness({
      entries: [entry('e1')],
      citations: [citation('c1', 'e1')],
    });
    t.repo.head = { sha: NEWER };

    await t.upkeep.codeLanded(landed(), queued());

    expect(t.reads).toEqual([{ path: 'src/retry.ts', ref: NEWER }]);
    expect(t.citations[0].checkedSha).toBe(NEWER);
  });

  it('[KG-6.2] updates the lines of a citation whose code moved, and leaves the entry in use', async () => {
    const t = harness({
      entries: [entry('e1')],
      citations: [citation('c1', 'e1')],
    });
    t.repo.code['src/retry.ts'] = MOVED;

    await t.upkeep.codeLanded(landed(), queued());

    expect(t.citations[0]).toMatchObject({
      checkResult: Check.MOVED,
      startLine: 4,
      endLine: 4,
      checkedSha: SHA,
    });
    expect(t.entries.get('e1')?.status).toBe(Status.STANDING);
    expect(t.maintenance).toEqual([]);
  });

  it('[KG-6.2] disputes an entry the changed code contradicts, and opens a correction issue labelled knowledge for the team that owns the module', async () => {
    const t = harness({
      entries: [entry('e1')],
      citations: [citation('c1', 'e1')],
    });
    t.repo.code['src/retry.ts'] = CHANGED;

    const summary = await t.upkeep.codeLanded(landed(), queued());

    expect(t.citations[0]).toMatchObject({
      checkResult: Check.CHANGED,
      judgment: Judgment.CONTRADICTED,
      checkedSha: SHA,
    });
    expect(t.entries.get('e1')?.status).toBe(Status.DISPUTED);
    expect(summary.disputed).toBe(1);

    expect(t.maintenance).toHaveLength(1);
    expect(t.maintenance[0]).toMatchObject({
      workspaceId: WORKSPACE,
      entryId: 'e1',
      action: Action.DISPUTED,
      reason: Reason.CITATION_CONTRADICTED,
      proposalState: null,
      evidence: {
        change: { sha: SHA, externalRepoId: 'gh-1', repo: 'acme/api' },
        citations: [
          expect.objectContaining({
            citationId: 'c1',
            path: 'src/retry.ts',
            lines: '2-2',
            readSha: SHA,
            judgment: Judgment.CONTRADICTED,
            judgeModel: 'judge-model',
          }),
        ],
      },
    });

    expect(t.issues).toHaveLength(1);
    const [issue] = t.issues;
    const label = t.labels.find((row) => row.name === KNOWLEDGE_LABEL);
    const bot = t.users.find((row) => row.username === KNOWLEDGE_BOT.slug);

    expect(t.maintenance[0].issueId).toBe(issue.id);
    expect(issue).toMatchObject({
      teamId: 'team-owner',
      // Where the team looks at requests, not planned work.
      stateId: 'team-owner-triage',
      labelIds: [label?.id],
      moduleIds: ['module-api'],
      createdById: bot?.id,
    });
    // Not delegated: a person or the team's own automation decides.
    expect(issue).not.toHaveProperty('assigneeId');
    expect(bot?.type).toBe('System');
    expect(issue.title).toContain('Retries make three attempts (e1).');
    // It cites the entry and the change.
    expect(issue.descriptionMarkdown).toContain('e1');
    expect(issue.descriptionMarkdown).toContain(SHA);
    expect(issue.descriptionMarkdown).toContain('acme/api');
    expect(issue.descriptionMarkdown).toContain('src/retry.ts');
    expect(issue.descriptionMarkdown).toContain('const attempts = 3;');
    expect(issue.descriptionMarkdown).toContain(
      'The code now makes five attempts, not three.',
    );
  });

  it('[KG-6.2] proposes archiving an entry whose cited file the change removed, and leaves it in use', async () => {
    const t = harness({
      entries: [entry('e1')],
      citations: [citation('c1', 'e1')],
    });
    t.repo.code['src/retry.ts'] = null;

    const summary = await t.upkeep.codeLanded(landed(), queued());

    expect(t.citations[0]).toMatchObject({
      checkResult: Check.MISSING,
      checkedSha: SHA,
    });
    expect(t.entries.get('e1')?.status).toBe(Status.STANDING);
    expect(t.maintenance).toEqual([
      expect.objectContaining({
        entryId: 'e1',
        action: Action.ARCHIVE_PROPOSED,
        reason: Reason.CITATION_MISSING,
        proposalState: ProposalState.OPEN,
      }),
    ]);
    expect(t.issues).toEqual([]);
    expect(summary.proposed).toBe(1);
  });

  it('[KG-6.2] with no model to judge a changed citation, asks a person instead of disputing', async () => {
    const t = harness({
      entries: [entry('e1')],
      citations: [citation('c1', 'e1')],
    });
    t.repo.code['src/retry.ts'] = CHANGED;
    const upkeep = t.build(
      CitationJudge.using(
        async () => {
          throw new Error('no model may be called');
        },
        () => false,
      ),
    );

    await upkeep.codeLanded(landed(), queued());

    expect(t.citations[0]).toMatchObject({
      checkResult: Check.CHANGED,
      judgment: Judgment.UNCLEAR,
    });
    expect(t.entries.get('e1')?.status).toBe(Status.STANDING);
    expect(t.maintenance).toEqual([
      expect.objectContaining({
        action: Action.ARCHIVE_PROPOSED,
        reason: Reason.CITATION_UNJUDGED,
        proposalState: ProposalState.OPEN,
      }),
    ]);
    expect(t.issues).toEqual([]);
  });

  it('[KG-6.2] asks instead of disputing an entry a person verified or on a locked page, and still opens the issue', async () => {
    const t = harness({
      pages: [
        {
          id: 'page-locked',
          workspaceId: WORKSPACE,
          title: 'Runbook',
          entryPolicy: 'LOCKED',
          deleted: null,
        },
      ],
      entries: [
        entry('verified', { verifiedAt: new Date() }),
        entry('locked', { pageId: 'page-locked' }),
      ],
      citations: [citation('c1', 'verified'), citation('c2', 'locked')],
    });
    t.repo.code['src/retry.ts'] = CHANGED;

    await t.upkeep.codeLanded(landed(), queued());

    expect(t.entries.get('verified')?.status).toBe(Status.STANDING);
    expect(t.entries.get('locked')?.status).toBe(Status.STANDING);
    expect(
      t.maintenance.map((row) => [row.entryId, row.action, row.reason]),
    ).toEqual([
      ['verified', Action.ARCHIVE_PROPOSED, Reason.CITATION_CONTRADICTED],
      ['locked', Action.ARCHIVE_PROPOSED, Reason.CITATION_CONTRADICTED],
    ]);
    expect(t.issues).toHaveLength(2);
    expect(t.maintenance.map((row) => row.issueId)).toEqual(
      t.issues.map((issue) => issue.id),
    );
    expect(t.issues[0].descriptionMarkdown).toContain('still in use');
  });

  it('[KG-6.2] only checks an entry still waiting on triage, which reads the fresh result when it decides', async () => {
    const t = harness({
      entries: [
        entry('e1', { status: Status.PROPOSED }),
        entry('e2', { status: Status.PROPOSED }),
      ],
      citations: [
        citation('c1', 'e1'),
        citation('c2', 'e2', { path: 'src/gone.ts' }),
      ],
    });
    t.repo.code['src/retry.ts'] = CHANGED;
    t.repo.code['src/gone.ts'] = null;

    await t.upkeep.codeLanded(
      landed(['src/retry.ts', 'src/gone.ts']),
      queued(),
    );

    expect(t.citations[0]).toMatchObject({
      checkResult: Check.CHANGED,
      judgment: Judgment.CONTRADICTED,
    });
    expect(t.citations[1]).toMatchObject({ checkResult: Check.MISSING });
    expect(t.entries.get('e1')?.status).toBe(Status.PROPOSED);
    expect(t.entries.get('e2')?.status).toBe(Status.PROPOSED);
    expect(t.maintenance).toEqual([]);
    expect(t.issues).toEqual([]);
  });

  it('[KG-6.2] keeps an entry in use whose changed code a judge found still supports it', async () => {
    const t = harness({
      entries: [entry('e1')],
      citations: [citation('c1', 'e1')],
    });
    t.repo.code['src/retry.ts'] = CHANGED;
    t.judge.judge.mockResolvedValueOnce({
      verdict: Judgment.HOLDS,
      model: 'judge-model',
      lines: '2-2',
      reason: 'Still retries; the count is not the claim.',
    });

    await t.upkeep.codeLanded(landed(), queued());

    expect(t.citations[0]).toMatchObject({
      checkResult: Check.CHANGED,
      judgment: Judgment.HOLDS,
      checkedSha: SHA,
    });
    expect(t.entries.get('e1')?.status).toBe(Status.STANDING);
    expect(t.maintenance).toEqual([]);
    expect(t.issues).toEqual([]);
  });

  it('[KG-6.2] leaves an entry out of use, and a citation never read, alone', async () => {
    const t = harness({
      entries: [entry('archived', { status: Status.ARCHIVED }), entry('e2')],
      citations: [
        citation('c1', 'archived'),
        citation('c2', 'e2', {
          checkResult: Check.UNKNOWN,
          snippet: null,
          checkedAt: null,
          checkedSha: null,
        }),
      ],
    });

    await t.upkeep.codeLanded(landed(), queued());

    expect(t.reads).toEqual([]);
  });

  it('[KG-6.2] checks one commit once, however often it is reported', async () => {
    const t = harness({
      entries: [entry('e1')],
      citations: [citation('c1', 'e1')],
    });
    t.repo.code['src/retry.ts'] = CHANGED;
    const first = queued();

    // The merged pull request and the push of its merge commit.
    await t.upkeep.codeLanded(landed(), first);
    await t.upkeep.codeLanded(landed(), new Date(first.getTime() + 1000));

    expect(t.reads).toHaveLength(1);
    expect(t.judge.judge).toHaveBeenCalledTimes(1);
    expect(t.issues).toHaveLength(1);

    // The first finished before the second was queued.
    const finished = harness({
      entries: [entry('e1')],
      citations: [
        citation('c1', 'e1', {
          checkedSha: SHA,
          checkedAt: new Date(Date.now() - 5 * MINUTE),
        }),
      ],
    });

    await finished.upkeep.codeLanded(landed(), queued());

    expect(finished.reads).toEqual([]);

    // The head moved on before the first ran, so it was checked at the head,
    // after the second report was queued: that one has nothing left to read.
    const moved = harness({
      entries: [entry('e1')],
      citations: [citation('c1', 'e1')],
    });
    moved.repo.head = { sha: NEWER };
    const reported = queued();

    await moved.upkeep.codeLanded(landed(), reported);
    await moved.upkeep.codeLanded(landed(), reported);

    expect(moved.reads).toHaveLength(1);
  });

  it('[KG-6.2] acts on what it could read, and retries only what it could not', async () => {
    const t = harness({
      entries: [entry('e1'), entry('e2')],
      citations: [
        citation('c1', 'e1'),
        citation('c2', 'e2', { path: 'src/big.ts' }),
      ],
    });
    t.repo.code['src/retry.ts'] = CHANGED;
    t.repo.code['src/big.ts'] = ORIGINAL;
    t.repo.tooLarge.add('src/big.ts');
    const since = queued();
    const change = landed(['src/retry.ts', 'src/big.ts']);

    await expect(t.upkeep.codeLanded(change, since)).rejects.toBeInstanceOf(
      UnreadCitations,
    );

    expect(t.entries.get('e1')?.status).toBe(Status.DISPUTED);
    expect(t.issues).toHaveLength(1);
    expect(t.citations[1].checkedSha).toBe('c'.repeat(40));

    t.repo.tooLarge.clear();
    t.reads.length = 0;
    await t.upkeep.codeLanded(change, since);

    expect(t.reads).toEqual([{ path: 'src/big.ts', ref: SHA }]);
    expect(t.citations[1]).toMatchObject({
      checkResult: Check.HOLDS,
      checkedSha: SHA,
    });
    expect(t.issues).toHaveLength(1);
    expect(t.maintenance).toHaveLength(1);
  });

  it('[KG-6.2] keeps a credential in cited code out of the correction issue', async () => {
    // Built at run time, so no credential-shaped text is in the source.
    const token = ['tg', 'pat', 'a1B2c3D4e5F6g7H8i9J0'].join('_');
    const t = harness({
      entries: [entry('e1')],
      citations: [
        citation('c1', 'e1', { snippet: `const token = '${token}';` }),
      ],
    });
    t.repo.code['src/retry.ts'] = CHANGED;

    await t.upkeep.codeLanded(landed(), queued());

    expect(t.issues).toHaveLength(1);
    expect(t.issues[0].descriptionMarkdown).not.toContain(token);
    expect(t.issues[0].descriptionMarkdown).toContain(
      '[withheld: Vantik token]',
    );
  });

  it('[KG-6.2] opens a correction issue an earlier run owed, once, and leaves one a run is still opening', async () => {
    const t = harness({
      entries: [entry('e1')],
      citations: [citation('c1', 'e1')],
    });
    t.repo.code['src/retry.ts'] = CHANGED;
    t.issueService.createIssueAPI.mockRejectedValueOnce(new Error('down'));
    const logged = jest
      .spyOn(LoggerService.prototype, 'error')
      .mockImplementation(() => undefined);

    await t.upkeep.codeLanded(landed(), queued());

    // The dispute stands; its issue is owed.
    expect(t.entries.get('e1')?.status).toBe(Status.DISPUTED);
    expect(t.maintenance[0].issueId).toBeNull();

    // Too recent: the run that wrote it may still be opening it.
    await t.upkeep.codeLanded(landed(['docs/unrelated.md']), queued());
    expect(t.issues).toHaveLength(0);

    t.maintenance[0].updatedAt = new Date(Date.now() - 11 * MINUTE);
    await t.upkeep.codeLanded(landed(['docs/unrelated.md']), queued());
    await t.upkeep.codeLanded(landed(['docs/unrelated.md']), queued());

    expect(t.issues).toHaveLength(1);
    expect(t.maintenance[0].issueId).toBe(t.issues[0].id);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it('[KG-6.2] asks rather than disputing again once a person has put the entry back', async () => {
    const t = harness({
      entries: [entry('e1')],
      citations: [citation('c1', 'e1')],
      maintenance: [
        {
          id: 'undone',
          workspaceId: WORKSPACE,
          entryId: 'e1',
          action: Action.DISPUTED,
          reason: Reason.CITATION_CONTRADICTED,
          proposalState: null,
          issueId: 'issue-old',
          reversedAt: new Date(Date.now() - 5 * DAY),
          reversedById: 'person-1',
          updatedAt: new Date(Date.now() - 5 * DAY),
        },
      ],
    });
    t.repo.code['src/retry.ts'] = CHANGED;

    await t.upkeep.codeLanded(landed(), queued());

    expect(t.entries.get('e1')?.status).toBe(Status.STANDING);
    expect(t.maintenance[1]).toMatchObject({
      action: Action.ARCHIVE_PROPOSED,
      reason: Reason.CITATION_CONTRADICTED,
      proposalState: ProposalState.OPEN,
    });
    expect(t.issues).toHaveLength(1);
  });

  it('[KG-6.2] does not ask twice: not while a proposal is open, nor soon after a person declined', async () => {
    const proposal = (overrides: Row): Row => ({
      id: `p-${JSON.stringify(overrides).length}`,
      workspaceId: WORKSPACE,
      entryId: 'e1',
      action: Action.ARCHIVE_PROPOSED,
      reason: Reason.CITATION_MISSING,
      issueId: null,
      reversedAt: null,
      updatedAt: new Date(),
      ...overrides,
    });
    const run = async (existing: Row) => {
      const t = harness({
        entries: [entry('e1')],
        citations: [citation('c1', 'e1')],
        maintenance: [existing],
      });
      t.repo.code['src/retry.ts'] = null;
      await t.upkeep.codeLanded(landed(), queued());

      return t.maintenance.length - 1;
    };

    expect(await run(proposal({ proposalState: ProposalState.OPEN }))).toBe(0);
    expect(
      await run(
        proposal({
          proposalState: ProposalState.DECLINED,
          resolvedAt: new Date(Date.now() - 10 * DAY),
        }),
      ),
    ).toBe(0);
    // Long enough ago to ask again, or declined for another reason.
    expect(
      await run(
        proposal({
          proposalState: ProposalState.DECLINED,
          resolvedAt: new Date(Date.now() - 100 * DAY),
        }),
      ),
    ).toBe(1);
    expect(
      await run(
        proposal({
          proposalState: ProposalState.DECLINED,
          reason: Reason.CITATION_UNJUDGED,
          resolvedAt: new Date(Date.now() - 10 * DAY),
        }),
      ),
    ).toBe(1);
  });
});

describe('who a correction issue goes to', () => {
  const productModule = (linkedTeamIds: string[]): Row => ({
    id: 'module-api',
    workspaceId: WORKSPACE,
    deleted: null,
    ownerTeamId: null,
    ownerProductId: 'product-1',
    linkedTeamIds,
  });
  const teams = ['team-old', 'team-linked', 'team-busy'].map(
    (id, index): Row => ({
      id,
      workspaceId: WORKSPACE,
      deleted: null,
      createdAt: new Date(index + 1),
    }),
  );
  const owner = (seed: Seed) =>
    new KnowledgeIssues(harness(seed).prisma as never, {} as never).owningTeam(
      WORKSPACE,
      ['module-api'],
    );

  it('[KG-6.2] a module a product owns goes to the team it links, then the team with the most issues in it, then the oldest team', async () => {
    expect(
      await owner({
        teams,
        modules: [productModule(['team-gone', 'team-linked'])],
        issueCounts: [{ teamId: 'team-busy', count: 9 }],
      }),
    ).toBe('team-linked');
    expect(
      await owner({
        teams,
        modules: [productModule([])],
        issueCounts: [
          { teamId: 'team-busy', count: 9 },
          { teamId: 'team-linked', count: 2 },
        ],
      }),
    ).toBe('team-busy');
    expect(await owner({ teams, modules: [productModule([])] })).toBe(
      'team-old',
    );
  });
});

describe('decay asks rather than archives what a person verified', () => {
  it('[KG-6.5] asks a person about a verified entry nobody used or found to hold in the window, once', async () => {
    const old = new Date(Date.now() - 400 * DAY);
    const t = harness({
      entries: [
        entry('unused', {
          verifiedAt: old,
          createdAt: old,
          lastServedAt: null,
        }),
        entry('served', {
          verifiedAt: old,
          createdAt: old,
          lastServedAt: new Date(Date.now() - DAY),
        }),
        entry('held', { verifiedAt: old, createdAt: old, lastServedAt: null }),
        entry('unverified', { createdAt: old, lastServedAt: null }),
        entry('recent', {
          verifiedAt: old,
          createdAt: new Date(Date.now() - 10 * DAY),
          lastServedAt: null,
        }),
      ],
      citations: [
        citation('c1', 'held', {
          checkResult: Check.HOLDS,
          checkedAt: new Date(Date.now() - 3 * DAY),
        }),
      ],
    });

    expect(await t.upkeep.proposeUnused()).toBe(1);
    expect(await t.upkeep.proposeUnused()).toBe(0);

    expect(t.maintenance).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE,
        entryId: 'unused',
        action: Action.ARCHIVE_PROPOSED,
        reason: Reason.UNUSED,
        proposalState: ProposalState.OPEN,
        evidence: { windowDays: 90, lastServedAt: null },
      }),
    ]);
    // Asked, not archived.
    expect(t.entries.get('unused')?.status).toBe(Status.STANDING);
  });
});

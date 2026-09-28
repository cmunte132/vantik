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
import { CODE_LANDED_JOB, type CodeLandedJob } from '../pages.interface';
import KnowledgeIssues, {
  KNOWLEDGE_BOT,
  KNOWLEDGE_LABEL,
} from './knowledge-issues';
import KnowledgeUpkeepService, {
  UnreadCitations,
} from './knowledge-upkeep.service';
import { type MaintenanceEvidence, proposalSummary } from './maintenance';

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
        ['in', 'notIn', 'not', 'lt', 'gte', 'hasSome', 'isEmpty'].some(
          (operator) => operator in c,
        )
      ) {
        return (
          (!('in' in c) || (c.in as unknown[]).includes(value)) &&
          (!('notIn' in c) || !(c.notIn as unknown[]).includes(value)) &&
          (!('isEmpty' in c) ||
            (((value as unknown[] | undefined) ?? []).length === 0) ===
              c.isEmpty) &&
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
  // Locks taken and citations stored, in order.
  const ops: string[] = [];
  const hooks: { rowLock?: (entryId: string) => void } = {};
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
    page: {
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        [...pages.values()].filter((row) => matches(row, where)),
      ),
    },
    $executeRaw: jest.fn(
      async (sql: TemplateStringsArray, ...values: unknown[]) => {
        if (sql.join('?').includes('FOR NO KEY UPDATE')) {
          ops.push(`row:${String(values[0])}`);
          // What a person's change waiting on the row does once it gets it,
          // as if it had committed just before.
          hooks.rowLock?.(String(values[0]));

          return 1;
        }

        ops.push(`lock:${String(values[0])}`);

        return 1;
      },
    ),
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
      findFirst: jest.fn(
        async ({ where }: { where: Where }) =>
          citations.find((row) => matches(row, where)) ?? null,
      ),
      updateMany: jest.fn(
        async ({ where, data }: { where: Where; data: Row }) => {
          const hit = citations.filter((row) => matches(row, where));
          hit.forEach((row) => {
            ops.push(`store:${row.id}`);
            Object.assign(row, data);
          });

          return { count: hit.length };
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
    ops,
    hooks,
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
    contentHash: `hash-${id}`,
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
    createdAt: new Date(Date.now() - 31 * DAY),
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

    await t.upkeep.codeLanded(landed());

    expect(t.reads).toEqual([{ path: 'src/retry.ts', ref: NEWER }]);
    expect(t.citations[0].checkedSha).toBe(NEWER);
  });

  it('[KG-6.2] updates the lines of a citation whose code moved, and leaves the entry in use', async () => {
    const t = harness({
      entries: [entry('e1')],
      citations: [citation('c1', 'e1')],
    });
    t.repo.code['src/retry.ts'] = MOVED;

    await t.upkeep.codeLanded(landed());

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

    const summary = await t.upkeep.codeLanded(landed());

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
        // The claim disputed, to tell a correction from the same claim put back.
        claim: 'hash-e1',
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
    expect(issue.descriptionMarkdown).toContain(
      `The change landed as \`${SHA}\` on acme/api.`,
    );
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

    const summary = await t.upkeep.codeLanded(landed());

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

    await upkeep.codeLanded(landed());

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

    await t.upkeep.codeLanded(landed());

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
    // Each says why it was asked about rather than disputed.
    expect(
      t.maintenance.map(
        (row) => (row.evidence as { askedBecause: string }).askedBecause,
      ),
    ).toEqual(['VERIFIED', 'LOCKED']);
    expect(t.issues[0].descriptionMarkdown).toContain(
      'A person verified it, so it is still in use',
    );
    expect(t.issues[1].descriptionMarkdown).toContain(
      'Its page is locked, so it is still in use',
    );
    expect(
      proposalSummary(
        Reason.CITATION_CONTRADICTED,
        t.maintenance[1].evidence as MaintenanceEvidence,
      ),
    ).toContain('Its page is locked, so it stays in use');
    // A row that did not record why says each way it could have been.
    expect(proposalSummary(Reason.CITATION_CONTRADICTED, {})).toContain(
      'A person verified it, its page is locked, or a person put it back, so',
    );
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

    await t.upkeep.codeLanded(landed(['src/retry.ts', 'src/gone.ts']));

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

    await t.upkeep.codeLanded(landed());

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

    await t.upkeep.codeLanded(landed());

    expect(t.reads).toEqual([]);
  });

  it('[KG-6.2] reads and judges one commit once while it is the head, however often it is reported', async () => {
    // Verified, so the first report asks rather than disputes and the entry
    // is still in use when the second arrives.
    const t = harness({
      entries: [entry('e1', { verifiedAt: new Date() })],
      citations: [citation('c1', 'e1')],
    });
    t.repo.code['src/retry.ts'] = CHANGED;

    // The merged pull request and the push of its merge commit.
    await t.upkeep.codeLanded(landed());
    await t.upkeep.codeLanded(landed());

    expect(t.reads).toHaveLength(1);
    expect(t.judge.judge).toHaveBeenCalledTimes(1);
    expect(t.maintenance).toHaveLength(1);
    expect(t.issues).toHaveLength(1);

    // Once more has landed, the second report reads the newer head, as the
    // first stored a reading of that and not of the change's commit.
    const moved = harness({
      entries: [entry('e1', { verifiedAt: new Date() })],
      citations: [citation('c1', 'e1')],
    });
    moved.repo.code['src/retry.ts'] = CHANGED;
    moved.repo.head = { sha: NEWER };

    await moved.upkeep.codeLanded(landed());
    await moved.upkeep.codeLanded(landed());

    expect(moved.reads).toEqual([
      { path: 'src/retry.ts', ref: NEWER },
      { path: 'src/retry.ts', ref: NEWER },
    ]);

    // Read at the change's commit before, by anything: not read again.
    const before = harness({
      entries: [entry('e1')],
      citations: [
        citation('c1', 'e1', {
          checkedSha: SHA,
          checkedAt: new Date(Date.now() - 5 * MINUTE),
        }),
      ],
    });

    await before.upkeep.codeLanded(landed());

    expect(before.reads).toEqual([]);
  });

  it('[KG-6.2] reads again a citation last read at another commit, however recently', async () => {
    // Read after this change was reported, by a job that had asked for the
    // head before the change landed: its reading says nothing about it.
    const t = harness({
      entries: [entry('e1')],
      citations: [
        citation('c1', 'e1', {
          checkedSha: 'b'.repeat(40),
          checkedAt: new Date(Date.now() - 1000),
        }),
      ],
    });
    t.repo.code['src/retry.ts'] = CHANGED;

    await t.upkeep.codeLanded(landed());

    expect(t.reads).toEqual([{ path: 'src/retry.ts', ref: SHA }]);
    expect(t.entries.get('e1')?.status).toBe(Status.DISPUTED);
    expect(t.issues).toHaveLength(1);
  });

  it('[KG-6.2] stamps a reading with when the head was asked for, not when the file was read', async () => {
    const asked = new Date('2026-01-01T00:00:00Z');
    jest.useFakeTimers({
      now: asked,
      doNotFake: [
        'nextTick',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
      ],
    });

    try {
      const t = harness({
        entries: [entry('e1')],
        citations: [citation('c1', 'e1', { checkedAt: new Date(0) })],
      });
      const read = t.files.read.getMockImplementation() as NonNullable<
        ReturnType<typeof t.files.read.getMockImplementation>
      >;
      // Reading the file takes a while: more may land meanwhile, and it is
      // not in the head already asked for.
      t.files.read.mockImplementation(async (...args) => {
        jest.setSystemTime(asked.getTime() + 5 * MINUTE);

        return read(...args);
      });

      await t.upkeep.codeLanded(landed());

      expect(t.citations[0]).toMatchObject({
        checkResult: Check.HOLDS,
        checkedAt: asked,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('[KG-6.2] never stores an older reading over a newer one, and acts on the newer one instead', async () => {
    const t = harness({
      entries: [entry('e1')],
      citations: [citation('c1', 'e1')],
    });
    const read = t.files.read.getMockImplementation() as NonNullable<
      ReturnType<typeof t.files.read.getMockImplementation>
    >;
    // While this job reads the old head, where the claim holds, a re-check
    // reads a newer one, which contradicts it, and stores that.
    t.files.read.mockImplementation(async (...args) => {
      Object.assign(t.citations[0], {
        checkedAt: new Date(Date.now() + MINUTE),
        checkedSha: NEWER,
        checkResult: Check.CHANGED,
        judgment: Judgment.CONTRADICTED,
        judgeModel: 'judge-model',
        judgeReason: 'The code now makes five attempts, not three.',
        judgedContentHash: 'hash-e1',
      });

      return read(...args);
    });

    await t.upkeep.codeLanded(landed());

    expect(t.citations[0]).toMatchObject({
      checkedSha: NEWER,
      checkResult: Check.CHANGED,
      judgment: Judgment.CONTRADICTED,
    });
    expect(t.entries.get('e1')?.status).toBe(Status.DISPUTED);
    expect(t.maintenance[0]).toMatchObject({
      action: Action.DISPUTED,
      reason: Reason.CITATION_CONTRADICTED,
      evidence: {
        change: expect.objectContaining({ sha: SHA }),
        citations: [
          expect.objectContaining({ citationId: 'c1', readSha: NEWER }),
        ],
      },
    });
    expect(t.issues).toHaveLength(1);
  });

  it('[KG-6.2] leaves a newer reading in place when a later change already acted on it', async () => {
    const t = harness({
      entries: [entry('e1')],
      citations: [citation('c1', 'e1')],
    });
    const read = t.files.read.getMockImplementation() as NonNullable<
      ReturnType<typeof t.files.read.getMockImplementation>
    >;
    // The job for a later change disputes the entry while this one reads.
    t.files.read.mockImplementation(async (...args) => {
      Object.assign(t.citations[0], {
        checkedAt: new Date(Date.now() + MINUTE),
        checkedSha: NEWER,
        checkResult: Check.CHANGED,
        judgment: Judgment.CONTRADICTED,
      });
      Object.assign(t.entries.get('e1') as Row, { status: Status.DISPUTED });

      return read(...args);
    });

    await t.upkeep.codeLanded(landed());

    expect(t.citations[0]).toMatchObject({
      checkedSha: NEWER,
      checkResult: Check.CHANGED,
    });
    expect(t.entries.get('e1')?.status).toBe(Status.DISPUTED);
    expect(t.maintenance).toEqual([]);
  });

  it('[KG-6.2] acts on a contradiction a re-check found at the change’s commit and only stored', async () => {
    const t = harness({
      entries: [entry('e1')],
      citations: [citation('c1', 'e1')],
    });
    t.repo.code['src/retry.ts'] = CHANGED;
    const citations = new EntryCitationsService(
      t.prisma as never,
      t.files as never,
      t.judge as never,
    );

    // A harmful signal: the re-check stores what it finds and acts on none.
    await citations.recheck('e1');

    expect(t.citations[0]).toMatchObject({
      checkedSha: SHA,
      judgment: Judgment.CONTRADICTED,
    });
    expect(t.entries.get('e1')?.status).toBe(Status.STANDING);

    await t.upkeep.codeLanded(landed());

    // Not read or judged again, and acted on.
    expect(t.reads).toHaveLength(1);
    expect(t.judge.judge).toHaveBeenCalledTimes(1);
    expect(t.entries.get('e1')?.status).toBe(Status.DISPUTED);
    expect(t.issues).toHaveLength(1);
  });

  it('[KG-6.2] a re-check never stores an older reading over a newer one', async () => {
    const t = harness({
      entries: [entry('e1')],
      citations: [citation('c1', 'e1')],
    });
    const read = t.files.read.getMockImplementation() as NonNullable<
      ReturnType<typeof t.files.read.getMockImplementation>
    >;
    t.files.read.mockImplementation(async (...args) => {
      Object.assign(t.citations[0], {
        checkedAt: new Date(Date.now() + MINUTE),
        checkedSha: NEWER,
      });

      return read(...args);
    });

    const { checked } = await new EntryCitationsService(
      t.prisma as never,
      t.files as never,
      t.judge as never,
    ).recheck('e1');

    expect(checked).toBe(0);
    expect(t.citations[0].checkedSha).toBe(NEWER);
    expect(t.ops).toEqual(['lock:knowledge-entry:e1']);
  });

  it('[KG-6.2] stores and acts on an entry’s readings under its lock', async () => {
    const t = harness({
      entries: [entry('e1')],
      citations: [citation('c1', 'e1')],
    });
    t.repo.code['src/retry.ts'] = null;

    await t.upkeep.codeLanded(landed());

    expect(t.ops.slice(0, 3)).toEqual([
      'lock:knowledge-entry:e1',
      'store:c1',
      'row:e1',
    ]);
    expect(t.maintenance).toHaveLength(1);
  });

  it('[KG-6.2] holds the entry’s row before reading it, so a person rewording it meanwhile is read, not disputed over', async () => {
    const t = harness({
      entries: [entry('e1')],
      citations: [citation('c1', 'e1')],
    });
    t.repo.code['src/retry.ts'] = CHANGED;
    // The person's change was waiting on the row, and lands first.
    t.hooks.rowLock = (id) =>
      Object.assign(t.entries.get(id) as Row, {
        content: 'Retries make five attempts.',
        contentHash: 'hash-reworded',
      });

    await expect(t.upkeep.codeLanded(landed())).rejects.toMatchObject({
      stale: 1,
    });
    expect(t.entries.get('e1')?.status).toBe(Status.STANDING);
    expect(t.maintenance).toEqual([]);
  });

  it('[KG-6.2] stamps an unread citation that names no commit, read at the head, with when the head was asked for', async () => {
    const asked = new Date('2026-01-01T00:00:00Z');
    jest.useFakeTimers({
      now: asked,
      doNotFake: [
        'nextTick',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
      ],
    });

    try {
      const t = harness({
        entries: [entry('e1')],
        citations: [
          citation('c1', 'e1', {
            createdAt: new Date(asked.getTime() - DAY),
            commitSha: null,
            checkResult: Check.UNKNOWN,
            checkedAt: null,
            checkedSha: null,
          }),
        ],
      });
      const read = t.files.read.getMockImplementation() as NonNullable<
        ReturnType<typeof t.files.read.getMockImplementation>
      >;
      t.files.read.mockImplementation(async (...args) => {
        jest.setSystemTime(asked.getTime() + MINUTE);

        return read(...args);
      });

      await new EntryCitationsService(
        t.prisma as never,
        t.files as never,
        t.judge as never,
      ).retryUnknown('e1');

      expect(t.citations[0]).toMatchObject({
        checkResult: Check.HOLDS,
        checkedSha: SHA,
        checkedAt: asked,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('[KG-6.2] ranks a reading of the commit a citation cites below a reading of a head, even in the same millisecond', async () => {
    jest.useFakeTimers({
      now: new Date('2026-01-01T00:00:00Z'),
      doNotFake: [
        'nextTick',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
      ],
    });

    try {
      const written = new Date(Date.now() - DAY);
      const t = harness({
        entries: [entry('e1')],
        citations: [
          citation('c1', 'e1', {
            createdAt: written,
            checkResult: Check.UNKNOWN,
            checkedAt: null,
            checkedSha: null,
          }),
        ],
      });
      const citations = new EntryCitationsService(
        t.prisma as never,
        t.files as never,
        t.judge as never,
      );

      // The retry reads the commit c1 cites, where the claim holds...
      await citations.retryUnknown('e1');

      expect(t.citations[0]).toMatchObject({
        checkResult: Check.HOLDS,
        checkedAt: written,
      });

      // ...and in the same millisecond a change lands that contradicts it.
      t.repo.code['src/retry.ts'] = CHANGED;
      await t.upkeep.codeLanded(landed());

      expect(t.citations[0]).toMatchObject({
        checkedSha: SHA,
        judgment: Judgment.CONTRADICTED,
      });
      expect(t.entries.get('e1')?.status).toBe(Status.DISPUTED);
    } finally {
      jest.useRealTimers();
    }
  });

  it('[KG-6.2] acts on what is stored once it holds the lock, not on a stored reading it found before', async () => {
    // A re-check read c1 at this change's commit, found a contradiction and
    // stored it; c2 has still to be read.
    const t = harness({
      entries: [entry('e1')],
      citations: [
        citation('c1', 'e1', {
          checkedSha: SHA,
          checkedAt: new Date(Date.now() - MINUTE),
          checkResult: Check.CHANGED,
          judgment: Judgment.CONTRADICTED,
          judgedContentHash: 'hash-e1',
        }),
        citation('c2', 'e1', { path: 'src/other.ts' }),
      ],
    });
    t.repo.code['src/other.ts'] = ORIGINAL;
    const read = t.files.read.getMockImplementation() as NonNullable<
      ReturnType<typeof t.files.read.getMockImplementation>
    >;
    // While c2 is read, a fix lands, and its job finds c1 holds again.
    t.files.read.mockImplementation(async (...args) => {
      Object.assign(t.citations[0], {
        checkedAt: new Date(Date.now() + MINUTE),
        checkedSha: NEWER,
        checkResult: Check.HOLDS,
        judgment: null,
        judgedContentHash: null,
      });

      return read(...args);
    });

    await t.upkeep.codeLanded(landed(['src/retry.ts', 'src/other.ts']));

    expect(t.reads).toEqual([{ path: 'src/other.ts', ref: SHA }]);
    expect(t.entries.get('e1')?.status).toBe(Status.STANDING);
    expect(t.maintenance).toEqual([]);
    expect(t.issues).toEqual([]);
  });

  it('[KG-6.2] never lets a reading of the commit a citation cites replace a reading of a head', async () => {
    for (const run of ['retry', 'recheck'] as const) {
      const t = harness({
        entries: [entry('e1')],
        citations: [
          citation('c1', 'e1', {
            checkResult: Check.UNKNOWN,
            checkedAt: null,
            checkedSha: null,
          }),
        ],
      });
      const read = t.files.read.getMockImplementation() as NonNullable<
        ReturnType<typeof t.files.read.getMockImplementation>
      >;
      // While this reads the commit c1 cites, where the claim holds, another
      // retry reads it first, and a landed change's check then reads the
      // head, asked for before this finishes, and stores a contradiction.
      t.files.read.mockImplementation(async (...args) => {
        Object.assign(t.citations[0], {
          checkedAt: new Date(Date.now() - 1000),
          checkedSha: SHA,
          checkResult: Check.CHANGED,
          judgment: Judgment.CONTRADICTED,
          judgedContentHash: 'hash-e1',
        });

        return read(...args);
      });
      const queue = { add: jest.fn(async (): Promise<void> => undefined) };
      const citations = new EntryCitationsService(
        t.prisma as never,
        t.files as never,
        t.judge as never,
        undefined,
        queue as never,
      );

      await (run === 'retry'
        ? citations.retryUnknown('e1')
        : citations.recheck('e1'));

      expect(t.citations[0]).toMatchObject({
        checkedSha: SHA,
        checkResult: Check.CHANGED,
        judgment: Judgment.CONTRADICTED,
      });
      expect(t.ops).toEqual(['lock:knowledge-entry:e1']);
      // What found it has already acted on it, at a newer commit.
      expect(queue.add).not.toHaveBeenCalled();
    }
  });

  it('[KG-6.2] hands a citation first found to hold at the commit it cites to the landed check, once the default branch has moved past that commit', async () => {
    const cited = 'c'.repeat(40);

    for (const run of ['retry', 'recheck'] as const) {
      const t = harness({
        entries: [entry('e1')],
        citations: [
          citation('c1', 'e1', {
            checkResult: Check.UNKNOWN,
            checkedAt: null,
            checkedSha: null,
          }),
        ],
      });
      // The claim held at the commit c1 cites. A change that landed while c1
      // was unread, and whose check passed it over, contradicts it at the
      // head.
      t.repo.code['src/retry.ts'] = CHANGED;
      const read = t.files.read.getMockImplementation() as NonNullable<
        ReturnType<typeof t.files.read.getMockImplementation>
      >;
      t.files.read.mockImplementation(async (repo, path, ref) =>
        ref === cited ? { content: ORIGINAL } : read(repo, path, ref),
      );
      const queue = { add: jest.fn(async (): Promise<void> => undefined) };
      const citations = new EntryCitationsService(
        t.prisma as never,
        t.files as never,
        t.judge as never,
        undefined,
        queue as never,
      );

      await (run === 'retry'
        ? citations.retryUnknown('e1')
        : citations.recheck('e1'));

      expect(t.citations[0]).toMatchObject({
        checkResult: Check.HOLDS,
        checkedSha: cited,
      });
      const job = { ...landed(), since: cited, citationIds: ['c1'] };
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        CODE_LANDED_JOB,
        job,
        expect.objectContaining({
          jobId: `${CODE_LANDED_JOB}:citation:c1:${SHA}`,
          attempts: 3,
        }),
      );

      // The check it queued reads the head, as the passed-over one would
      // have, and disputes the entry.
      await t.upkeep.codeLanded(job);

      expect(t.citations[0]).toMatchObject({
        checkedSha: SHA,
        judgment: Judgment.CONTRADICTED,
      });
      expect(t.entries.get('e1')?.status).toBe(Status.DISPUTED);
      // Which change since the cited commit touched the code is not known,
      // so the correction issue names none of them as the change.
      expect(t.issues).toHaveLength(1);
      expect(t.issues[0].descriptionMarkdown).toContain(
        'It was checked at the head of the default branch on acme/api, ' +
          `against the changes that landed after \`${cited}\`, the commit ` +
          'it was first read at.',
      );
      expect(t.issues[0].descriptionMarkdown).toContain(
        `read at \`${SHA.slice(0, 7)}\``,
      );
      expect(t.issues[0].descriptionMarkdown).not.toContain('landed as');
    }
  });

  it('[KG-6.2] asks for the head again once a first reading is stored, so a change landing while it was read is checked against it', async () => {
    const cited = 'c'.repeat(40);

    for (const run of ['retry', 'recheck'] as const) {
      // Retry: c1 names no commit and is read at the head, SHA. Re-check: c1
      // cites the head, and the head was asked for, for c0, before c1 was
      // read. Either way, while c1 is read a change lands as NEWER; its
      // check finds c1 unread and passes it over.
      const pinned = run === 'recheck';
      const t = harness({
        entries: [entry('e1')],
        citations: [
          ...(pinned
            ? [citation('c0', 'e1', { path: 'src/other.ts', commitSha: null })]
            : []),
          citation('c1', 'e1', {
            checkResult: Check.UNKNOWN,
            checkedAt: null,
            checkedSha: null,
            commitSha: pinned ? cited : null,
          }),
        ],
      });
      t.repo.head = { sha: pinned ? cited : SHA };
      t.repo.code['src/other.ts'] = ORIGINAL;
      const read = t.files.read.getMockImplementation() as NonNullable<
        ReturnType<typeof t.files.read.getMockImplementation>
      >;
      t.files.read.mockImplementation(async (repo, path, ref) => {
        if (path === 'src/retry.ts') {
          t.repo.head = { sha: NEWER };
        }

        return read(repo, path, ref);
      });
      const queue = { add: jest.fn(async (): Promise<void> => undefined) };

      await new EntryCitationsService(
        t.prisma as never,
        t.files as never,
        t.judge as never,
        undefined,
        queue as never,
      )[pinned ? 'recheck' : 'retryUnknown']('e1');

      const read1 = pinned ? cited : SHA;
      expect(t.reads).toEqual([
        ...(pinned ? [{ path: 'src/other.ts', ref: cited }] : []),
        { path: 'src/retry.ts', ref: read1 },
      ]);
      expect(t.citations.find((c) => c.id === 'c1')).toMatchObject({
        checkResult: Check.HOLDS,
        checkedSha: read1,
      });
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        CODE_LANDED_JOB,
        {
          workspaceId: WORKSPACE,
          externalRepoId: 'gh-1',
          sha: NEWER,
          changedPaths: ['src/retry.ts'],
          since: read1,
          citationIds: ['c1'],
        },
        expect.objectContaining({
          jobId: `${CODE_LANDED_JOB}:citation:c1:${NEWER}`,
        }),
      );
    }
  });

  it('[KG-6.2] checks only the citation it hands on, not the other citations of its file', async () => {
    const cited = 'c'.repeat(40);
    const older = 'b'.repeat(40);
    const t = harness({
      entries: [entry('e1'), entry('e2')],
      citations: [
        citation('c1', 'e1', {
          checkResult: Check.UNKNOWN,
          checkedAt: null,
          checkedSha: null,
        }),
        // Read at an older commit: a change's own job gave up on it, or its
        // entry came back into use since.
        citation('c2', 'e2', { commitSha: older, checkedSha: older }),
      ],
    });
    t.repo.code['src/retry.ts'] = CHANGED;
    const read = t.files.read.getMockImplementation() as NonNullable<
      ReturnType<typeof t.files.read.getMockImplementation>
    >;
    t.files.read.mockImplementation(async (repo, path, ref) =>
      ref === cited ? { content: ORIGINAL } : read(repo, path, ref),
    );
    const queue = { add: jest.fn(async (): Promise<void> => undefined) };

    await new EntryCitationsService(
      t.prisma as never,
      t.files as never,
      t.judge as never,
      undefined,
      queue as never,
    ).retryUnknown('e1');

    const [[, job]] = queue.add.mock.calls as unknown as Array<
      [string, CodeLandedJob]
    >;
    const summary = await t.upkeep.codeLanded(job);

    expect(summary).toMatchObject({ checked: 1, disputed: 1 });
    expect(t.reads).toEqual([{ path: 'src/retry.ts', ref: SHA }]);
    expect(t.entries.get('e1')?.status).toBe(Status.DISPUTED);
    // c2 is left to the checks of the changes themselves, whose commits it
    // was not read at.
    expect(t.entries.get('e2')?.status).toBe(Status.STANDING);
    expect(t.citations.find((c) => c.id === 'c2')).toMatchObject({
      checkedSha: older,
      judgment: null,
    });
    expect(t.issues).toHaveLength(1);
  });

  it('[KG-6.2] hands the landed check nothing for a first reading that no change since could have been checked against', async () => {
    const cited = 'c'.repeat(40);
    const cases: Array<{
      name: string;
      citation?: Row;
      head?: { sha: string } | { unknown: true; reason: string };
      atCited?: string | null;
    }> = [
      { name: 'the head is the commit it cites', head: { sha: cited } },
      { name: 'it never held there', atCited: null },
      { name: 'it names no commit', citation: { commitSha: null } },
      {
        name: 'the head cannot be read',
        head: { unknown: true, reason: 'rate limited' },
      },
    ];

    for (const c of cases) {
      for (const run of ['retry', 'recheck'] as const) {
        const t = harness({
          entries: [entry('e1')],
          citations: [
            citation('c1', 'e1', {
              checkResult: Check.UNKNOWN,
              checkedAt: null,
              checkedSha: null,
              ...c.citation,
            }),
          ],
        });
        t.repo.head = c.head ?? t.repo.head;
        const read = t.files.read.getMockImplementation() as NonNullable<
          ReturnType<typeof t.files.read.getMockImplementation>
        >;
        t.files.read.mockImplementation(async (repo, path, ref) =>
          ref === cited && c.atCited === null
            ? { missing: true }
            : read(repo, path, ref),
        );
        const queue = { add: jest.fn(async (): Promise<void> => undefined) };

        await new EntryCitationsService(
          t.prisma as never,
          t.files as never,
          t.judge as never,
          undefined,
          queue as never,
        )[run === 'retry' ? 'retryUnknown' : 'recheck']('e1');

        expect({ case: c.name, run, queued: queue.add.mock.calls }).toEqual({
          case: c.name,
          run,
          queued: [],
        });
      }
    }
  });

  it('[KG-6.2] keeps a first reading when the landed check cannot be queued', async () => {
    const t = harness({
      entries: [entry('e1')],
      citations: [
        citation('c1', 'e1', {
          checkResult: Check.UNKNOWN,
          checkedAt: null,
          checkedSha: null,
        }),
      ],
    });
    const queue = {
      add: jest.fn(async () => {
        throw new Error('queue down');
      }),
    };

    await expect(
      new EntryCitationsService(
        t.prisma as never,
        t.files as never,
        t.judge as never,
        undefined,
        queue as never,
      ).retryUnknown('e1'),
    ).resolves.toEqual({ stillUnknown: 0 });

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(t.citations[0]).toMatchObject({ checkResult: Check.HOLDS });
  });

  describe('a person acting on an entry after its citations were read', () => {
    beforeEach(() =>
      jest.useFakeTimers({
        now: new Date('2026-01-01T00:00:00Z'),
        doNotFake: [
          'nextTick',
          'queueMicrotask',
          'setImmediate',
          'clearImmediate',
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
        ],
      }),
    );
    afterEach(() => jest.useRealTimers());

    const later = () => jest.setSystemTime(Date.now() + MINUTE);

    /** The first run disputes e1 over c1, and cannot read c2. */
    const disputedWithOneUnread = async () => {
      const t = harness({
        entries: [entry('e1')],
        citations: [
          citation('c1', 'e1'),
          citation('c2', 'e1', { path: 'src/big.ts' }),
        ],
      });
      t.repo.code['src/retry.ts'] = CHANGED;
      t.repo.code['src/big.ts'] = ORIGINAL;
      t.repo.tooLarge.add('src/big.ts');
      const change = landed(['src/retry.ts', 'src/big.ts']);

      await expect(t.upkeep.codeLanded(change)).rejects.toThrow(
        UnreadCitations,
      );
      expect(t.entries.get('e1')?.status).toBe(Status.DISPUTED);
      expect(t.issues).toHaveLength(1);
      t.repo.tooLarge.delete('src/big.ts');
      later();

      return { t, change };
    };

    const putBack = (t: ReturnType<typeof harness>, words?: string) => {
      Object.assign(t.entries.get('e1') as Row, {
        status: Status.STANDING,
        ...(words && { content: words, contentHash: `hash-${words}` }),
      });
      Object.assign(t.maintenance[0], {
        reversedAt: new Date(),
        reversedById: 'person-1',
      });
      later();
    };

    it('[KG-6.2] reads again on its retry, and does not raise again, a contradiction a person overruled', async () => {
      const { t, change } = await disputedWithOneUnread();

      // The person reads the code and puts the entry back as it was.
      putBack(t);
      await t.upkeep.codeLanded(change);

      // Read and judged again, as the person acted after the first reading,
      // and found as they overruled it: nothing is raised.
      expect(t.judge.judge).toHaveBeenCalledTimes(2);
      expect(t.entries.get('e1')?.status).toBe(Status.STANDING);
      expect(t.maintenance).toHaveLength(1);
      expect(t.issues).toHaveLength(1);
    });

    it('[KG-6.2] does not raise again a contradiction a person overruled once unrelated commits moved the head, and asks when the code judged changed', async () => {
      const { t, change } = await disputedWithOneUnread();

      // Commits that leave the cited lines as they were land meanwhile.
      t.repo.head = { sha: NEWER };
      putBack(t);
      await t.upkeep.codeLanded(change);

      expect(t.citations[0]).toMatchObject({ checkedSha: NEWER });
      expect(t.maintenance).toHaveLength(1);
      expect(t.issues).toHaveLength(1);

      // Code around the cited lines changes again: that is not what the
      // person overruled, so they are asked.
      const again = await disputedWithOneUnread();

      again.t.repo.head = { sha: NEWER };
      again.t.repo.code['src/retry.ts'] = CHANGED.replace(
        'return attempts;',
        'return attempts + 1;',
      );
      putBack(again.t);
      await again.t.upkeep.codeLanded(again.change);

      expect(again.t.maintenance[1]).toMatchObject({
        action: Action.ARCHIVE_PROPOSED,
        evidence: expect.objectContaining({ askedBecause: 'RESTORED' }),
      });
    });

    it('[KG-6.2] does not raise again a stored judgment a person overruled, read again after they put the entry back', async () => {
      const first = await disputedWithOneUnread();
      const code = first.t.citations[0].judgedCodeHash;
      // A re-check after the person put it back found the same, and stored
      // it without acting on it.
      const t = harness({
        entries: [entry('e1')],
        citations: [
          citation('c1', 'e1', {
            checkedSha: SHA,
            checkedAt: new Date(Date.now() - MINUTE),
            checkResult: Check.CHANGED,
            judgment: Judgment.CONTRADICTED,
            judgedContentHash: 'hash-e1',
            judgedCodeHash: code,
          }),
        ],
        maintenance: [
          {
            ...first.t.maintenance[0],
            reversedAt: new Date(Date.now() - 2 * MINUTE),
            reversedById: 'person-1',
          },
        ],
      });

      await t.upkeep.codeLanded(landed());

      expect(t.reads).toEqual([]);
      expect(t.maintenance).toHaveLength(1);
      expect(t.issues).toEqual([]);
    });

    it('[KG-6.2] judges the words a person corrected an entry to on its retry, not the words disputed', async () => {
      const { t, change } = await disputedWithOneUnread();

      putBack(t, 'Retries make five attempts.');
      t.judge.judge.mockResolvedValueOnce({
        verdict: Judgment.HOLDS,
        model: 'judge-model',
        lines: '2-2',
        reason: 'Five attempts, as it says.',
      });
      await t.upkeep.codeLanded(change);

      expect(t.judge.judge).toHaveBeenLastCalledWith(
        expect.objectContaining({ claim: 'Retries make five attempts.' }),
      );
      expect(t.citations[0]).toMatchObject({
        judgment: Judgment.HOLDS,
        judgedContentHash: 'hash-Retries make five attempts.',
      });
      expect(t.entries.get('e1')?.status).toBe(Status.STANDING);
      expect(t.maintenance).toHaveLength(1);
      expect(t.issues).toHaveLength(1);
    });

    it('[KG-6.2] judges again, rather than acting on, a stored judgment of words the entry no longer has', async () => {
      // A re-check judged c1 at this change's commit; a person has reworded
      // the entry since.
      const t = harness({
        entries: [
          entry('e1', {
            content: 'Retries make five attempts.',
            contentHash: 'hash-reworded',
          }),
        ],
        citations: [
          citation('c1', 'e1', {
            checkedSha: SHA,
            checkedAt: new Date(Date.now() - MINUTE),
            checkResult: Check.CHANGED,
            judgment: Judgment.CONTRADICTED,
            judgedContentHash: 'hash-e1',
          }),
        ],
      });
      t.repo.code['src/retry.ts'] = CHANGED;
      t.judge.judge.mockResolvedValueOnce({
        verdict: Judgment.HOLDS,
        model: 'judge-model',
        lines: '2-2',
        reason: 'Five attempts, as it says.',
      });

      await t.upkeep.codeLanded(landed());

      expect(t.judge.judge).toHaveBeenCalledWith(
        expect.objectContaining({ claim: 'Retries make five attempts.' }),
      );
      expect(t.entries.get('e1')?.status).toBe(Status.STANDING);
      expect(t.maintenance).toEqual([]);
    });

    it('[KG-6.2] acts on no judgment of words a person changed while it was made, and reads it again', async () => {
      const t = harness({
        entries: [entry('e1')],
        citations: [citation('c1', 'e1')],
      });
      t.repo.code['src/retry.ts'] = CHANGED;
      t.judge.judge.mockImplementationOnce(async () => {
        Object.assign(t.entries.get('e1') as Row, {
          content: 'Retries make five attempts.',
          contentHash: 'hash-reworded',
        });

        return {
          verdict: Judgment.CONTRADICTED,
          model: 'judge-model',
          lines: '2-2',
          reason: 'The code now makes five attempts, not three.',
        };
      });

      await expect(t.upkeep.codeLanded(landed())).rejects.toMatchObject({
        unread: 0,
        stale: 1,
      });
      expect(t.citations[0]).toMatchObject({ judgedContentHash: 'hash-e1' });
      expect(t.entries.get('e1')?.status).toBe(Status.STANDING);
      expect(t.maintenance).toEqual([]);

      later();
      t.judge.judge.mockResolvedValueOnce({
        verdict: Judgment.HOLDS,
        model: 'judge-model',
        lines: '2-2',
        reason: 'Five attempts, as it says.',
      });
      await t.upkeep.codeLanded(landed());

      expect(t.judge.judge).toHaveBeenLastCalledWith(
        expect.objectContaining({ claim: 'Retries make five attempts.' }),
      );
      expect(t.citations[0]).toMatchObject({
        judgment: Judgment.HOLDS,
        judgedContentHash: 'hash-reworded',
      });
      expect(t.maintenance).toEqual([]);
    });

    it('[KG-6.2] acts on no stored reading taken before a person put the entry back, and reads it again', async () => {
      const t = harness({
        entries: [entry('e1')],
        citations: [citation('c1', 'e1')],
        maintenance: [
          {
            id: 'earlier',
            workspaceId: WORKSPACE,
            entryId: 'e1',
            action: Action.DISPUTED,
            reason: Reason.CITATION_CONTRADICTED,
            proposalState: null,
            issueId: 'issue-old',
            evidence: {
              claim: 'hash-e1',
              citations: [{ citationId: 'c1', readSha: 'b'.repeat(40) }],
            },
            reversedAt: null,
            updatedAt: new Date(),
          },
          // Put back long before: the latest putting back is what counts.
          {
            id: 'long-ago',
            workspaceId: WORKSPACE,
            entryId: 'e1',
            action: Action.DISPUTED,
            reason: Reason.CITATION_CONTRADICTED,
            proposalState: null,
            issueId: 'issue-older',
            evidence: { claim: 'hash-e1' },
            reversedAt: new Date(Date.now() - 10 * DAY),
            reversedById: 'person-1',
            updatedAt: new Date(Date.now() - 10 * DAY),
          },
        ],
      });
      t.repo.code['src/retry.ts'] = CHANGED;
      const read = t.files.read.getMockImplementation() as NonNullable<
        ReturnType<typeof t.files.read.getMockImplementation>
      >;
      // While this reads, a later change's check stores a newer reading,
      // and after it a person puts the entry back.
      t.files.read.mockImplementation(async (...args) => {
        Object.assign(t.citations[0], {
          checkedAt: new Date(Date.now() + MINUTE),
          checkedSha: NEWER,
          checkResult: Check.CHANGED,
          judgment: Judgment.CONTRADICTED,
          judgedContentHash: 'hash-e1',
        });
        Object.assign(t.maintenance[0], {
          reversedAt: new Date(Date.now() + 2 * MINUTE),
          reversedById: 'person-1',
        });

        return read(...args);
      });

      await expect(t.upkeep.codeLanded(landed())).rejects.toMatchObject({
        stale: 1,
      });
      expect(t.maintenance).toHaveLength(2);
      expect(t.issues).toEqual([]);
    });
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
    const change = landed(['src/retry.ts', 'src/big.ts']);

    await expect(t.upkeep.codeLanded(change)).rejects.toBeInstanceOf(
      UnreadCitations,
    );

    expect(t.entries.get('e1')?.status).toBe(Status.DISPUTED);
    expect(t.issues).toHaveLength(1);
    expect(t.citations[1].checkedSha).toBe('c'.repeat(40));

    t.repo.tooLarge.clear();
    t.reads.length = 0;
    await t.upkeep.codeLanded(change);

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

    await t.upkeep.codeLanded(landed());

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

    await t.upkeep.codeLanded(landed());

    // The dispute stands; its issue is owed.
    expect(t.entries.get('e1')?.status).toBe(Status.DISPUTED);
    expect(t.maintenance[0].issueId).toBeNull();

    // Too recent: the run that wrote it may still be opening it.
    await t.upkeep.codeLanded(landed(['docs/unrelated.md']));
    expect(t.issues).toHaveLength(0);

    t.maintenance[0].updatedAt = new Date(Date.now() - 11 * MINUTE);
    await t.upkeep.codeLanded(landed(['docs/unrelated.md']));
    await t.upkeep.codeLanded(landed(['docs/unrelated.md']));

    expect(t.issues).toHaveLength(1);
    expect(t.maintenance[0].issueId).toBe(t.issues[0].id);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it('[KG-6.2] opens owed correction issues in the workspace a change landed in, or in every one from the nightly pass', async () => {
    const owed = (id: string, workspaceId: string): Row => ({
      id,
      workspaceId,
      entryId: 'e1',
      action: Action.DISPUTED,
      reason: Reason.CITATION_CONTRADICTED,
      proposalState: null,
      issueId: null,
      reversedAt: null,
      evidence: {},
      updatedAt: new Date(Date.now() - 11 * MINUTE),
    });
    const t = harness({
      entries: [entry('e1')],
      maintenance: [owed('here', WORKSPACE), owed('there', 'workspace-2')],
      teams: [WORKSPACE, 'workspace-2'].map((workspaceId, index): Row => ({
        id: `team-${index}`,
        workspaceId,
        deleted: null,
        createdAt: new Date(index + 1),
      })),
    });

    expect(await t.upkeep.openOwedIssues(WORKSPACE)).toBe(1);
    expect(t.maintenance.map((row) => row.issueId !== null)).toEqual([
      true,
      false,
    ]);

    expect(await t.upkeep.openOwedIssues()).toBe(1);
    expect(t.maintenance.every((row) => row.issueId !== null)).toBe(true);
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

    await t.upkeep.codeLanded(landed());

    expect(t.entries.get('e1')?.status).toBe(Status.STANDING);
    expect(t.maintenance[1]).toMatchObject({
      action: Action.ARCHIVE_PROPOSED,
      reason: Reason.CITATION_CONTRADICTED,
      proposalState: ProposalState.OPEN,
      evidence: expect.objectContaining({ askedBecause: 'RESTORED' }),
    });
    expect(t.issues).toHaveLength(1);
    expect(t.issues[0].descriptionMarkdown).toContain(
      'A person put it back after it was last disputed',
    );
    expect(t.issues[0].descriptionMarkdown).not.toContain('verified');
  });

  it('[KG-6.2] disputes again an entry a person corrected before putting it back, and asks about one put back unchanged', async () => {
    // The code this change gives c1 to judge, as a hash.
    const judged = harness({
      entries: [entry('e1')],
      citations: [citation('c1', 'e1')],
    });
    judged.repo.code['src/retry.ts'] = CHANGED;
    await judged.upkeep.codeLanded(landed());
    const code = judged.citations[0].judgedCodeHash;

    expect(code).toEqual(expect.any(String));

    const run = async (claim: string) => {
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
            // Overruled for c1 over other code, and for c2 over this code:
            // neither is the judgment this change gives.
            evidence: {
              claim,
              citations: [
                { citationId: 'c1', judgedCodeHash: 'other code' },
                { citationId: 'c2', judgedCodeHash: code },
              ],
            },
            reversedAt: new Date(Date.now() - 5 * DAY),
            reversedById: 'person-1',
            updatedAt: new Date(Date.now() - 5 * DAY),
          },
        ],
      });
      t.repo.code['src/retry.ts'] = CHANGED;

      await t.upkeep.codeLanded(landed());

      return [t.entries.get('e1')?.status, t.maintenance[1]?.action];
    };

    // Corrected: a new claim, which the changed code contradicts in turn.
    expect(await run('hash-before-the-correction')).toEqual([
      Status.DISPUTED,
      Action.DISPUTED,
    ]);
    // The same claim put back: the person has read the code.
    expect(await run('hash-e1')).toEqual([
      Status.STANDING,
      Action.ARCHIVE_PROPOSED,
    ]);
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
      await t.upkeep.codeLanded(landed());

      return t.maintenance.length - 1;
    };

    expect(await run(proposal({ proposalState: ProposalState.OPEN }))).toBe(0);
    // Open for another reason: asked about this one too.
    expect(
      await run(
        proposal({ proposalState: ProposalState.OPEN, reason: Reason.UNUSED }),
      ),
    ).toBe(1);
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

describe('a contradiction found while the entry is asked about for something else', () => {
  it('[KG-6.2] is still asked about, with its correction issue', async () => {
    const t = harness({
      entries: [entry('e1', { verifiedAt: new Date() })],
      citations: [citation('c1', 'e1')],
      maintenance: [
        {
          id: 'unused',
          workspaceId: WORKSPACE,
          entryId: 'e1',
          action: Action.ARCHIVE_PROPOSED,
          reason: Reason.UNUSED,
          proposalState: ProposalState.OPEN,
          issueId: null,
          reversedAt: null,
          updatedAt: new Date(),
        },
      ],
    });
    t.repo.code['src/retry.ts'] = CHANGED;

    const summary = await t.upkeep.codeLanded(landed());

    expect(summary.proposed).toBe(1);
    expect(t.maintenance[1]).toMatchObject({
      action: Action.ARCHIVE_PROPOSED,
      reason: Reason.CITATION_CONTRADICTED,
      proposalState: ProposalState.OPEN,
    });
    expect(t.issues).toHaveLength(1);
    expect(t.maintenance[1].issueId).toBe(t.issues[0].id);
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
    // Under the entry's lock, so two passes never both ask.
    expect(t.ops).toContain('lock:knowledge-entry:unused');

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

  it('[KG-7.4] does not ask about a verified entry a live page cites, which is read through the page', async () => {
    const old = new Date(Date.now() - 400 * DAY);
    const unused = {
      verifiedAt: old,
      createdAt: old,
      lastServedAt: null as Date | null,
    };
    const t = harness({
      pages: [
        {
          id: 'page-generated',
          workspaceId: WORKSPACE,
          deleted: null,
          citedEntryIds: ['cited'],
        },
        {
          id: 'page-gone',
          workspaceId: WORKSPACE,
          deleted: new Date(),
          citedEntryIds: ['cited by a deleted page'],
        },
        {
          id: 'page-elsewhere',
          workspaceId: 'workspace-2',
          deleted: null,
          citedEntryIds: ['cited in another workspace'],
        },
      ],
      entries: [
        entry('cited', unused),
        entry('cited by a deleted page', unused),
        entry('cited in another workspace', unused),
      ],
    });

    expect(await t.upkeep.proposeUnused(WORKSPACE)).toBe(2);
    expect(t.maintenance.map((row) => row.entryId).sort()).toEqual([
      'cited by a deleted page',
      'cited in another workspace',
    ]);
  });
});

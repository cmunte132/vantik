/**
 * Knowledge gaps become issues: a question the knowledge keeps failing to
 * answer gets one issue asking a person to answer it, on the team of the
 * module it names, and the gap is answered once an entry citing that issue is
 * accepted.
 *
 * Built from the real gap service over an in-memory store that answers the
 * filters it writes. Opening an issue is faked. No network and no model is
 * used.
 */
import { LoggerService } from 'modules/logger/logger.service';

import { answerGaps } from './gap-answers';
import KnowledgeGapsService, {
  GAP_ISSUE_TITLE_PREFIX,
  gapIssueTitle,
  moduleOfQuery,
} from './knowledge-gaps.service';
import KnowledgeIssues, { type KnowledgeIssue } from './knowledge-issues';

const WORKSPACE = 'workspace-1';
const OTHER = 'workspace-2';

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

      if (['in', 'not', 'gte', 'contains'].some((operator) => operator in c)) {
        return (
          (!('in' in c) || (c.in as unknown[]).includes(value)) &&
          (!('not' in c) || (value ?? null) !== c.not) &&
          (!('gte' in c) || (value != null && compare(value, c.gte) >= 0)) &&
          (!('contains' in c) ||
            (typeof value === 'string' && value.includes(c.contains as string)))
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
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }

  return a instanceof Date && b instanceof Date
    ? a.getTime() - b.getTime()
    : String(a).localeCompare(String(b));
}

function ordered(
  rows: Row[],
  orderBy: Array<Record<string, 'asc' | 'desc'>> | undefined,
): Row[] {
  const keys = (orderBy ?? []).flatMap((order) => Object.entries(order));

  return [...rows].sort((a, b) => {
    for (const [key, direction] of keys) {
      const difference = compare(a[key], b[key]);

      if (difference) {
        return direction === 'desc' ? -difference : difference;
      }
    }

    return 0;
  });
}

interface Seed {
  gaps?: Row[];
  issues?: Row[];
  entries?: Row[];
  citations?: Row[];
  preferences?: unknown;
  /** The workspace has no team, so no issue can be opened. */
  noTeam?: boolean;
  /** Runs while a gap's lock is waited for, as a second run's work would. */
  whileLocked?: (key: string) => void;
  /** Workspaces whose gaps cannot be read. */
  broken?: string[];
}

function harness(seed: Seed = {}) {
  let next = 0;
  let clock = Date.UTC(2026, 8, 1);
  const tick = () => new Date((clock += 1000));

  const gaps: Row[] = (seed.gaps ?? []).map((gap): Row => ({
    workspaceId: WORKSPACE,
    count: 1,
    issueId: null,
    moduleId: null,
    answeredAt: null,
    answeredByEntryId: null,
    createdAt: tick(),
    updatedAt: tick(),
    ...gap,
  }));
  const issues: Row[] = (seed.issues ?? []).map((issue): Row => ({
    deleted: null,
    createdAt: tick(),
    team: { workspaceId: WORKSPACE, deleted: null },
    ...issue,
  }));
  const entries: Row[] = (seed.entries ?? []).map((entry): Row => {
    const row: Row = {
      deleted: null,
      pageId: 'page-1',
      page: { workspaceId: WORKSPACE, deleted: null },
      ...entry,
    };

    // An entry carries its page's workspace, as a row in postgres does.
    return { workspaceId: (row.page as Row).workspaceId, ...row };
  });
  const citations: Row[] = (seed.citations ?? []).map((citation): Row => ({
    id: `citation-${++next}`,
    kind: 'ISSUE',
    createdAt: tick(),
    ...citation,
  }));
  const workspaces: Row[] = [
    {
      id: WORKSPACE,
      deleted: null as Date | null,
      preferences: seed.preferences ?? null,
    },
    { id: OTHER, deleted: null as Date | null, preferences: null as unknown },
  ];
  const modules: Row[] = [
    { id: 'module-api', key: 'api', name: 'Public API', createdAt: tick() },
    { id: 'module-cache', key: 'cache', name: 'Cache', createdAt: tick() },
    { id: 'module-web', key: 'web', name: 'Webapp', createdAt: tick() },
  ].map((module): Row => ({
    workspaceId: WORKSPACE,
    deleted: null,
    ...module,
  }));
  const moduleRepos: Row[] = [
    {
      moduleId: 'module-api',
      fullName: 'acme/app',
      pathPrefixes: ['apps/api/'],
    },
    {
      moduleId: 'module-cache',
      fullName: 'acme/app',
      pathPrefixes: ['apps/api/src/cache/'],
    },
    {
      moduleId: 'module-web',
      fullName: 'acme/app',
      pathPrefixes: ['apps/web/'],
    },
  ].map((repo): Row => ({
    deleted: null,
    createdAt: tick(),
    module: { workspaceId: WORKSPACE, deleted: null },
    ...repo,
  }));
  const locks: string[] = [];
  const opened: KnowledgeIssue[] = [];

  const withEntry = (citation: Row): Row => ({
    ...citation,
    entry: entries.find((entry) => entry.id === citation.entryId) ?? {},
  });

  const prisma = {
    pageKnowledgeGap: {
      findMany: async ({
        where,
        orderBy,
        take,
        distinct,
      }: {
        where: Where;
        orderBy?: Array<Record<string, 'asc' | 'desc'>>;
        take?: number;
        distinct?: string[];
      }) => {
        if (
          typeof where.workspaceId === 'string' &&
          seed.broken?.includes(where.workspaceId)
        ) {
          throw new Error('the database is not answering');
        }

        let rows = ordered(
          gaps.filter((gap) => matches(gap, where)),
          orderBy,
        );

        if (distinct) {
          rows = rows.filter(
            (row, index) =>
              rows.findIndex((other) =>
                distinct.every((key) => other[key] === row[key]),
              ) === index,
          );
        }

        return rows.slice(0, take ?? rows.length).map((row) => ({ ...row }));
      },
      findFirst: async ({ where }: { where: Where }) => {
        const row = gaps.find((gap) => matches(gap, where));

        return row ? { ...row } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = gaps.find((gap) => gap.id === where.id);

        if (!row) {
          throw new Error(`No gap ${where.id}`);
        }

        Object.assign(row, data, { updatedAt: tick() });

        return { ...row };
      },
      updateMany: async ({ where, data }: { where: Where; data: Row }) => {
        const rows = gaps.filter((gap) => matches(gap, where));

        rows.forEach((row) => Object.assign(row, data, { updatedAt: tick() }));

        return { count: rows.length };
      },
    },
    pageEntryCitation: {
      findMany: async ({
        where,
        orderBy,
      }: {
        where: Where;
        orderBy?: Array<Record<string, 'asc' | 'desc'>>;
      }) =>
        ordered(
          citations.map(withEntry).filter((row) => matches(row, where)),
          orderBy,
        ),
    },
    workspace: {
      findFirst: async ({ where }: { where: Where }) =>
        workspaces.find((workspace) => matches(workspace, where)) ?? null,
    },
    module: {
      findMany: async ({
        where,
        orderBy,
      }: {
        where: Where;
        orderBy?: Record<string, 'asc' | 'desc'>;
      }) =>
        ordered(
          modules.filter((module) => matches(module, where)),
          orderBy ? [orderBy] : undefined,
        ),
    },
    moduleRepo: {
      findMany: async ({
        where,
        orderBy,
      }: {
        where: Where;
        orderBy?: Record<string, 'asc' | 'desc'>;
      }) =>
        ordered(
          moduleRepos.filter((repo) => matches(repo, where)),
          orderBy ? [orderBy] : undefined,
        ),
    },
    issue: {
      findFirst: async ({
        where,
        orderBy,
      }: {
        where: Where;
        orderBy?: Record<string, 'asc' | 'desc'>;
      }) =>
        ordered(
          issues.filter((issue) => matches(issue, where)),
          orderBy ? [orderBy] : undefined,
        )[0] ?? null,
    },
    $executeRaw: async (_strings: TemplateStringsArray, key: string) => {
      locks.push(key);
      seed.whileLocked?.(key);

      return 1;
    },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
      work(prisma),
  };

  const knowledgeIssues = {
    open: jest.fn(async (issue: KnowledgeIssue) => {
      if (seed.noTeam) {
        return null;
      }

      const id = `issue-${++next}`;

      opened.push(issue);
      issues.push({
        id,
        title: issue.title,
        // Stored as the editor's document, which carries the text as written.
        description: JSON.stringify({ type: 'doc', text: issue.markdown }),
        deleted: null,
        createdAt: tick(),
        team: { workspaceId: issue.workspaceId, deleted: null },
      });

      return { id };
    }),
  };

  const service = new KnowledgeGapsService(
    prisma as never,
    knowledgeIssues as unknown as KnowledgeIssues,
  );

  return {
    service,
    prisma,
    gaps,
    issues,
    opened,
    locks,
    open: knowledgeIssues.open,
    gap: (id: string) => gaps.find((gap) => gap.id === id) as Row,
  };
}

beforeEach(() => {
  jest.spyOn(LoggerService.prototype, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ------------------------------------------------------------- the questions

describe('opening issues for knowledge gaps', () => {
  it('[KG-6.4] opens one issue for each gap asked at least the threshold, most-asked first, and stores it on the gap', async () => {
    const h = harness({
      gaps: [
        { id: 'gap-5', query: 'how are refunds rounded', count: 5 },
        { id: 'gap-4', query: 'which queue sends email', count: 4 },
        { id: 'gap-9', query: 'where do feature flags live', count: 9 },
      ],
    });

    expect(await h.service.openIssues()).toEqual({ opened: 2, answered: 0 });

    // Five is the default threshold, and five is enough.
    expect(h.opened.map((issue) => issue.title)).toEqual([
      `${GAP_ISSUE_TITLE_PREFIX}where do feature flags live`,
      `${GAP_ISSUE_TITLE_PREFIX}how are refunds rounded`,
    ]);
    expect(h.opened[0]).toMatchObject({
      workspaceId: WORKSPACE,
      moduleIds: [],
    });
    expect(h.opened[0].markdown).toContain('9 times');
    expect(h.opened[0].markdown).toContain('> where do feature flags live');
    // The gap's id is in the issue, so a later run can find it.
    expect(h.opened[0].markdown).toContain('gap-9');
    expect(h.gap('gap-9').issueId).toBe(h.issues[0].id);
    expect(h.gap('gap-5').issueId).toBe(h.issues[1].id);
    expect(h.gap('gap-4').issueId).toBeNull();
    // Each under its own gap's lock.
    expect(h.locks).toEqual(['knowledge-gap:gap-9', 'knowledge-gap:gap-5']);
  });

  it('[KG-6.4] uses the workspace’s own threshold over the default', async () => {
    const h = harness({
      preferences: { knowledge: { gapIssueMinCount: 2 } },
      gaps: [
        { id: 'gap-2', query: 'who owns billing', count: 2 },
        { id: 'gap-1', query: 'is there a staging database', count: 1 },
      ],
    });

    await h.service.openIssues();

    expect(h.opened.map((issue) => issue.title)).toEqual([
      `${GAP_ISSUE_TITLE_PREFIX}who owns billing`,
    ]);
  });

  it('[KG-6.4] opens no issue in a workspace that switched them off for itself', async () => {
    const h = harness({
      preferences: { knowledge: { gapIssuesCron: 'off' } },
      gaps: [{ id: 'gap-1', query: 'who owns billing', count: 9 }],
    });

    expect(await h.service.openIssues()).toEqual({ opened: 0, answered: 0 });
    expect(h.open).not.toHaveBeenCalled();
    expect(h.gap('gap-1').issueId).toBeNull();
  });

  it('[KG-6.4] never opens a second issue for the same gap', async () => {
    const h = harness({
      gaps: [{ id: 'gap-1', query: 'how are refunds rounded', count: 6 }],
    });

    await h.service.openIssues();
    // Asked again since, and the job runs again.
    h.gap('gap-1').count = 20;
    expect(await h.service.openIssues()).toEqual({ opened: 0, answered: 0 });

    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.issues).toHaveLength(1);
  });

  it('[KG-6.4] finds the issue a run left behind before it could store it, by its title and the gap it names', async () => {
    const title = gapIssueTitle('how are refunds rounded');
    const h = harness({
      gaps: [
        { id: 'gap-1', query: 'how are refunds rounded', count: 6 },
        { id: 'gap-2', query: 'which queue sends email', count: 6 },
      ],
      issues: [
        // A person's issue with the same title is not the gap's.
        { id: 'issue-person', title, description: 'Refunds look off to me' },
        // Nor is one that was deleted.
        {
          id: 'issue-deleted',
          title,
          description: 'Knowledge gap `gap-1`.',
          deleted: new Date(),
        },
        { id: 'issue-left', title, description: 'Knowledge gap `gap-1`.' },
        // The same gap id under another title is another issue.
        {
          id: 'issue-other',
          title: gapIssueTitle('something else'),
          description: 'Knowledge gap `gap-2`.',
        },
        // And one in another workspace is that workspace's.
        {
          id: 'issue-elsewhere',
          title: gapIssueTitle('which queue sends email'),
          description: 'Knowledge gap `gap-2`.',
          team: { workspaceId: OTHER, deleted: null },
        },
      ],
    });

    expect(await h.service.openIssues()).toEqual({ opened: 1, answered: 0 });

    expect(h.gap('gap-1').issueId).toBe('issue-left');
    expect(h.opened.map((issue) => issue.title)).toEqual([
      gapIssueTitle('which queue sends email'),
    ]);
    expect(h.gap('gap-2').issueId).not.toBe('issue-elsewhere');
  });

  it('[KG-6.4] leaves a gap alone when another run stored its issue while this one waited for the lock', async () => {
    const h: ReturnType<typeof harness> = harness({
      gaps: [{ id: 'gap-1', query: 'how are refunds rounded', count: 6 }],
      // Called only once the run is under way, when `h` is set.
      whileLocked: () => {
        h.gap('gap-1').issueId = 'issue-from-the-other-run';
      },
    });

    expect(await h.service.openIssues()).toEqual({ opened: 0, answered: 0 });
    expect(h.open).not.toHaveBeenCalled();
    expect(h.gap('gap-1').issueId).toBe('issue-from-the-other-run');
  });

  it('[KG-6.4] puts the issue on the module the question names, when it names exactly one', async () => {
    const h = harness({
      gaps: [
        { id: 'by-path', query: 'why is apps/web/src/app.tsx slow', count: 8 },
        {
          id: 'by-nested-path',
          query: 'what evicts from `apps/api/src/cache/keys.ts`',
          count: 7,
        },
        { id: 'by-name', query: 'rate limits of the public api', count: 6 },
        { id: 'by-two', query: 'does the webapp read the cache', count: 5 },
        { id: 'by-none', query: 'who is on call', count: 5 },
      ],
    });

    await h.service.openIssues();

    expect(
      Object.fromEntries(
        h.gaps.map((gap) => [gap.id, [gap.moduleId, gap.issueId !== null]]),
      ),
    ).toEqual({
      'by-path': ['module-web', true],
      'by-nested-path': ['module-cache', true],
      'by-name': ['module-api', true],
      'by-two': [null, true],
      'by-none': [null, true],
    });
    expect(h.opened.map((issue) => issue.moduleIds)).toEqual([
      ['module-web'],
      ['module-cache'],
      ['module-api'],
      [],
      [],
    ]);
  });

  it('[KG-6.4] opens at most ten issues in a workspace a run, and the rest on later runs', async () => {
    const h = harness({
      gaps: Array.from({ length: 12 }, (_, index) => ({
        id: `gap-${index}`,
        query: `question number ${index}`,
        count: 50 - index,
      })),
    });

    expect((await h.service.openIssues()).opened).toBe(10);
    expect(h.gap('gap-9').issueId).not.toBeNull();
    expect(h.gap('gap-10').issueId).toBeNull();

    expect((await h.service.openIssues()).opened).toBe(2);
    expect(h.gaps.every((gap) => gap.issueId !== null)).toBe(true);
  });

  it('[KG-6.4] tries a gap again on the next run when there is no team to hold its issue', async () => {
    const h = harness({
      noTeam: true,
      gaps: [{ id: 'gap-1', query: 'how are refunds rounded', count: 6 }],
    });

    expect(await h.service.openIssues()).toEqual({ opened: 0, answered: 0 });
    expect(h.gap('gap-1').issueId).toBeNull();
    expect(h.open).toHaveBeenCalledTimes(1);

    await h.service.openIssues();
    expect(h.open).toHaveBeenCalledTimes(2);
  });

  it('[KG-6.4] opens no issue for a gap already answered, however often it is asked', async () => {
    const h = harness({
      gaps: [
        {
          id: 'gap-1',
          query: 'how are refunds rounded',
          count: 40,
          answeredAt: new Date(),
        },
      ],
    });

    await h.service.openIssues();

    expect(h.open).not.toHaveBeenCalled();

    // Nor does it take the place of one that is not answered.
    const crowded = harness({
      gaps: [
        ...Array.from({ length: 10 }, (_, index) => ({
          id: `answered-${index}`,
          query: `answered question ${index}`,
          count: 90,
          answeredAt: new Date(),
        })),
        { id: 'open', query: 'how are refunds rounded', count: 6 },
      ],
    });

    expect((await crowded.service.openIssues()).opened).toBe(1);
    expect(crowded.gap('open').issueId).not.toBeNull();
  });

  it('[KG-6.4] opens no issue in a workspace that was deleted', async () => {
    const h = harness({
      gaps: [{ id: 'gap-1', query: 'how are refunds rounded', count: 6 }],
    });
    (await h.prisma.workspace.findFirst({
      where: { id: WORKSPACE },
    }))!.deleted = new Date();

    expect(await h.service.openIssues()).toEqual({ opened: 0, answered: 0 });
    expect(h.open).not.toHaveBeenCalled();
  });

  it('[KG-6.4] carries on with other workspaces when one fails, and fails the run at the end', async () => {
    const h = harness({
      broken: [WORKSPACE],
      gaps: [
        { id: 'gap-1', query: 'how are refunds rounded', count: 6 },
        {
          id: 'gap-2',
          query: 'which queue sends email',
          count: 6,
          workspaceId: OTHER,
        },
      ],
    });

    await expect(h.service.openIssues()).rejects.toThrow(
      `Knowledge gap issues failed in 1 workspace(s): ${WORKSPACE}`,
    );
    expect(h.gap('gap-2').issueId).not.toBeNull();
    expect(h.opened.map((issue) => issue.workspaceId)).toEqual([OTHER]);
  });

  it('[KG-6.4] withholds a secret someone searched for from the issue', async () => {
    const token = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_');
    const h = harness({
      gaps: [{ id: 'gap-1', query: `why does ${token} fail`, count: 6 }],
    });

    await h.service.openIssues();

    expect(h.opened[0].title).not.toContain(token);
    expect(h.opened[0].markdown).not.toContain(token);
    expect(h.opened[0].title).toContain('[withheld:');
  });

  it('[KG-6.4] gives every run the same title for a question, cut when long', () => {
    expect(gapIssueTitle('how  are refunds\nrounded')).toBe(
      `${GAP_ISSUE_TITLE_PREFIX}how are refunds rounded`,
    );

    const long = 'why '.repeat(40).trim();
    const title = gapIssueTitle(long);

    expect(title).toBe(gapIssueTitle(long));
    expect(title).toHaveLength(GAP_ISSUE_TITLE_PREFIX.length + 100);
    expect(title.endsWith('...')).toBe(true);

    // A hundred characters are quoted whole; one more is cut.
    const hundred = 'a'.repeat(100);

    expect(gapIssueTitle(hundred)).toBe(`${GAP_ISSUE_TITLE_PREFIX}${hundred}`);
    expect(gapIssueTitle(`${hundred}b`)).toBe(
      `${GAP_ISSUE_TITLE_PREFIX}${'a'.repeat(97)}...`,
    );
  });
});

describe('answering knowledge gaps', () => {
  const answered = {
    gaps: [
      { id: 'gap-1', query: 'how are refunds rounded', issueId: 'issue-1' },
      { id: 'gap-2', query: 'which queue sends email', issueId: 'issue-2' },
      { id: 'gap-3', query: 'who owns billing', issueId: 'issue-3' },
      { id: 'gap-4', query: 'what is a tenant', issueId: 'issue-4' },
      { id: 'gap-5', query: 'where are the docs', issueId: 'issue-5' },
    ],
    entries: [
      { id: 'standing', status: 'STANDING' },
      { id: 'folded', status: 'CONSOLIDATED' },
      { id: 'waiting', status: 'PROPOSED' },
      { id: 'removed', status: 'STANDING', deleted: new Date() },
      {
        id: 'elsewhere',
        status: 'STANDING',
        page: { workspaceId: OTHER, deleted: null },
      },
      {
        id: 'on-a-deleted-page',
        status: 'STANDING',
        page: { workspaceId: WORKSPACE, deleted: new Date() },
      },
    ],
    citations: [
      { entryId: 'standing', targetId: 'issue-1' },
      { entryId: 'folded', targetId: 'issue-2' },
      { entryId: 'waiting', targetId: 'issue-3' },
      { entryId: 'removed', targetId: 'issue-4' },
      { entryId: 'elsewhere', targetId: 'issue-4' },
      { entryId: 'on-a-deleted-page', targetId: 'issue-5' },
      // Naming the issue some other way is not citing it.
      { entryId: 'standing', targetId: 'issue-3', kind: 'PULL_REQUEST' },
    ],
  };

  it('[KG-6.4] marks a gap answered once an entry citing its issue is accepted, from where it was accepted', async () => {
    const h = harness(answered);

    expect(
      await answerGaps(h.prisma as never, [
        'standing',
        'folded',
        'waiting',
        'removed',
        'elsewhere',
        'on-a-deleted-page',
      ]),
    ).toBe(2);

    expect(h.gap('gap-1')).toMatchObject({ answeredByEntryId: 'standing' });
    expect(h.gap('gap-1').answeredAt).toBeInstanceOf(Date);
    expect(h.gap('gap-2')).toMatchObject({ answeredByEntryId: 'folded' });
    for (const id of ['gap-3', 'gap-4', 'gap-5']) {
      expect(h.gap(id)).toMatchObject({
        answeredAt: null,
        answeredByEntryId: null,
      });
    }
    expect(await answerGaps(h.prisma as never, [])).toBe(0);
  });

  it('[KG-6.4] marks what an acceptance missed on the job’s next run', async () => {
    const h = harness(answered);

    expect(await h.service.openIssues()).toEqual({ opened: 0, answered: 2 });

    expect(h.gap('gap-1').answeredByEntryId).toBe('standing');
    expect(h.gap('gap-2').answeredByEntryId).toBe('folded');
    expect(h.gap('gap-3').answeredAt).toBeNull();
    expect(h.gap('gap-4').answeredAt).toBeNull();
    expect(h.gap('gap-5').answeredAt).toBeNull();
  });

  it('[KG-6.4] keeps the first accepted answer, and answers only gaps in the entry’s own workspace', async () => {
    const earlier = new Date(Date.UTC(2026, 0, 1));
    const h = harness({
      gaps: [
        {
          id: 'gap-1',
          query: 'how are refunds rounded',
          issueId: 'issue-1',
          answeredAt: earlier,
          answeredByEntryId: 'first',
        },
        { id: 'gap-2', query: 'which queue', issueId: 'issue-2' },
        {
          id: 'gap-other',
          query: 'which queue',
          issueId: 'issue-2',
          workspaceId: OTHER,
        },
      ],
      entries: [
        { id: 'second', status: 'STANDING' },
        { id: 'third', status: 'STANDING' },
      ],
      citations: [
        { entryId: 'second', targetId: 'issue-1' },
        { entryId: 'second', targetId: 'issue-2' },
        { entryId: 'third', targetId: 'issue-2' },
      ],
    });

    expect(await answerGaps(h.prisma as never, ['third', 'second'])).toBe(1);

    expect(h.gap('gap-1')).toMatchObject({
      answeredAt: earlier,
      answeredByEntryId: 'first',
    });
    // Cited first, so it answered first.
    expect(h.gap('gap-2').answeredByEntryId).toBe('second');
    expect(h.gap('gap-other').answeredAt).toBeNull();
  });
});

describe('the module a question names', () => {
  const modules = [
    { id: 'api', key: 'api', name: 'Public API' },
    { id: 'cache', key: 'cache', name: 'Cache' },
    { id: 'web', key: 'web', name: 'Webapp' },
  ];
  const folders = [
    { moduleId: 'api', fullName: 'acme/app', pathPrefixes: ['apps/API/'] },
    {
      moduleId: 'cache',
      fullName: 'acme/app',
      pathPrefixes: ['apps/api/src/cache/'],
    },
    { moduleId: 'web', fullName: 'acme/web', pathPrefixes: [] },
  ];

  it('[KG-6.4] reads a path as the deepest module holding it', () => {
    // Questions are stored lower-cased; a folder is compared the same way.
    expect(moduleOfQuery('what does apps/api/main.ts do', [], folders)).toBe(
      'api',
    );
    expect(moduleOfQuery('apps/api/src/cache/keys.ts?', [], folders)).toBe(
      'cache',
    );
    // A folder, with or without its slash, is held as a file in it is.
    expect(moduleOfQuery('"./apps/api/"', [], folders)).toBe('api');
    // No module holds it.
    expect(moduleOfQuery('what is in docs/intro.md', [], folders)).toBeNull();
  });

  it('[KG-6.4] reads a path in the repository it starts with, and a whole repository only when it is the only one', () => {
    expect(moduleOfQuery('acme/web/src/index.ts', [], folders)).toBe('web');
    // Two repositories: a path naming neither is not the whole of either.
    expect(moduleOfQuery('src/index.ts', [], folders)).toBeNull();
    expect(moduleOfQuery('src/index.ts', [], folders.slice(2))).toBe('web');
    // Named in another repository, a folder of this one does not hold it.
    expect(moduleOfQuery('acme/web/apps/api/x.ts', [], folders)).toBe('web');
  });

  it('[KG-6.4] reads a module’s name or short name written as words, and no module from several', () => {
    expect(moduleOfQuery('rate limits of the public api', modules, [])).toBe(
      'api',
    );
    expect(moduleOfQuery('Does the CACHE expire?', modules, [])).toBe('cache');
    // The short name alone names the module.
    expect(moduleOfQuery('what are the api rate limits', modules, [])).toBe(
      'api',
    );
    // Part of a word is not the word.
    expect(moduleOfQuery('webhooks and caches', modules, [])).toBeNull();
    expect(moduleOfQuery('how do webhooks retry', modules, [])).toBeNull();
    // Two modules named: no one module.
    expect(moduleOfQuery('the webapp and the cache', modules, [])).toBeNull();
    // A name and a path of the same module are one module.
    expect(
      moduleOfQuery('cache eviction in apps/api/src/cache', modules, folders),
    ).toBe('cache');
    expect(moduleOfQuery('who is on call', modules, folders)).toBeNull();
  });
});

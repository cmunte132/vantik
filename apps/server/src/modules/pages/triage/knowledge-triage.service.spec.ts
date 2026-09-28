/**
 * Triage of new entries, from the entry as it was written to the decision
 * recorded about it and what that decision did.
 *
 * Against an in-memory store that answers the filters the service writes,
 * so the neighbourhood, the "written before" order and the conditional
 * updates are exercised as postgres would apply them. The index is a fake
 * that returns the neighbours a test names, and the judges are the real
 * `TriageJudges` over a completion that answers from the test: no model is
 * ever called.
 */
import type KnowledgeIndexService from '../knowledge-index.service';

import {
  KnowledgeEscalationReason as Reason,
  KnowledgeTriageDecisionType as Decision,
  KnowledgeTriageMode,
  KnowledgeTriagePolicy,
  PageEntryRelationDecider as Decider,
  PageEntryRelationType as Relation,
} from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import type { VectorService } from 'modules/vector/vector.service';

import { contentHashOf } from '../page-entries.service';
import { auditDraw } from './agreement';
import KnowledgeTriageService, {
  digestOf,
  MAX_CITED_TEXT,
} from './knowledge-triage.service';
import TriageJudges, { type Complete } from './triage-judges';

const WORKSPACE = 'workspace-1';
const SERVER = 'module-server';
const WEBAPP = 'module-webapp';
const PAGE = 'page-1';
const OTHER_PAGE = 'page-2';
const LOCKED_PAGE = 'page-locked';
const RUN = '11111111-2222-4333-8444-555555555555';

const ON = { KNOWLEDGE_AUTO_TRIAGE: 'on' };
const SHADOW = { KNOWLEDGE_AUTO_TRIAGE: 'shadow' };

const T0 = new Date('2026-09-01T00:00:00Z').getTime();
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

// ----------------------------------------------------------------- the store

interface Citation {
  kind: string;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  snippet: string | null;
  targetId: string | null;
  targetLabel: string | null;
  checkResult: string | null;
}

interface Row {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  deleted: Date | null;
  content: string;
  contentHash: string | null;
  scope: string | null;
  kind: string;
  status: string;
  moduleIds: string[];
  pageId: string;
  supersedesId: string | null;
  sourceUserId: string | null;
  sourceSession: string | null;
  verifiedAt: Date | null;
  corroborationCount: number;
  citations: Citation[];
}

interface PageRow {
  id: string;
  workspaceId: string;
  deleted: Date | null;
  entryPolicy: string;
  workspace: { preferences: unknown };
}

type Where = Record<string, unknown>;

/** Whether a row meets a filter, in the subset of Prisma's the service writes. */
function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') {
      return (condition as Where[]).some((part) => matches(row, part));
    }

    const value = row[key];

    if (condition === null) {
      return value === null || value === undefined;
    }

    if (condition instanceof Date) {
      return value instanceof Date && value.getTime() === condition.getTime();
    }

    if (typeof condition === 'object' && !Array.isArray(condition)) {
      const c = condition as Record<string, unknown>;

      if (['in', 'not', 'lt', 'lte', 'gte', 'hasSome'].some((op) => op in c)) {
        return (
          (!('in' in c) || (c.in as unknown[]).includes(value)) &&
          (!('not' in c) || value !== c.not) &&
          (!('lt' in c) || compare(value, c.lt) < 0) &&
          (!('lte' in c) || compare(value, c.lte) <= 0) &&
          (!('gte' in c) || compare(value, c.gte) >= 0) &&
          (!('hasSome' in c) ||
            (c.hasSome as unknown[]).some((item) =>
              (value as unknown[]).includes(item),
            ))
        );
      }

      // A relation, matched against the related row.
      return (
        typeof value === 'object' &&
        value !== null &&
        matches(value as Record<string, unknown>, c)
      );
    }

    return value === condition;
  });
}

function compare(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() - b.getTime();
  }

  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

interface Run {
  id: string;
  workspaceId: string;
  agentUserId: string;
  createdAt: Date;
  finishedAt: Date | null;
  deleted: Date | null;
  modelId: string | null;
  issue: {
    id: string;
    sourceMetadata: unknown;
    support: { id: string } | null;
    team: { preferences: unknown } | null;
    linkedIssue: Array<{ sourceData: unknown; sync: boolean }>;
    comments: Array<{ createdAt: Date; sourceMetadata: unknown }>;
  };
}

/** An issue or comment an entry can cite. */
interface Target {
  id: string;
  deleted: Date | null;
  /** An issue's. */
  title?: string;
  description?: string | null;
  sourceMetadata: unknown;
  support?: { id: string } | null;
  team?: { workspaceId: string; deleted: Date | null; preferences: unknown };
  linkedIssue?: Array<{ sourceData: unknown; sync: boolean }>;
  comments?: Array<{ createdAt: Date; sourceMetadata: unknown }>;
  /** A comment's. */
  body?: string;
  issue?: {
    deleted: Date | null;
    team: { workspaceId: string; deleted: Date | null };
  };
}

/** A decision type stopping or resuming, as recorded. */
interface Backoff {
  workspaceId: string;
  decision: string;
  backedOff: boolean;
  createdAt: Date;
}

/** Who wrote what: agents, a person, and an account that is neither. */
const USERS: Record<string, string> = {
  'agent-1': 'Agent',
  'agent-2': 'Agent',
  'person-1': 'User',
  'system-1': 'System',
};

function store(
  rows: Row[],
  options: {
    runs?: Run[];
    issues?: Target[];
    comments?: Target[];
    preferences?: unknown;
    backoff?: Backoff[];
    gaps?: Array<Record<string, unknown>>;
  } = {},
) {
  const page = (id: string, entryPolicy = 'CURATED'): PageRow => ({
    id,
    workspaceId: WORKSPACE,
    deleted: null,
    entryPolicy,
    workspace: { preferences: options.preferences ?? {} },
  });
  const pages = new Map<string, PageRow>([
    [PAGE, page(PAGE)],
    [OTHER_PAGE, page(OTHER_PAGE)],
    [LOCKED_PAGE, page(LOCKED_PAGE, 'LOCKED')],
  ]);
  const entries = new Map(rows.map((row) => [row.id, row]));
  const decisions: Array<Record<string, unknown>> = [];
  const relations: Array<Record<string, unknown>> = [];

  const view = (row: Row) => ({ ...row, page: pages.get(row.pageId) });

  const client = {
    pageEntry: {
      findFirst: jest.fn(async ({ where }: { where: Where }) => {
        const row = [...entries.values()]
          .map(view)
          .find((candidate) => matches(candidate, where));

        return row ?? null;
      }),
      findMany: jest.fn(
        async ({ where, orderBy }: { where: Where; orderBy?: unknown }) => {
          const found = [...entries.values()]
            .map(view)
            .filter((candidate) => matches(candidate, where));

          return orderBy
            ? found.sort(
                (a, b) =>
                  compare(a.createdAt, b.createdAt) || compare(a.id, b.id),
              )
            : found;
        },
      ),
      updateMany: jest.fn(
        async ({ where, data }: { where: Where; data: Where }) => {
          let count = 0;

          for (const row of entries.values()) {
            if (!matches(view(row), where)) {
              continue;
            }

            for (const [key, value] of Object.entries(data)) {
              const increment = (value as { increment?: number })?.increment;
              (row as unknown as Record<string, unknown>)[key] =
                typeof increment === 'number'
                  ? ((row as unknown as Record<string, number>)[key] ?? 0) +
                    increment
                  : value;
            }

            row.updatedAt = new Date(row.updatedAt.getTime() + 1);
            count++;
          }

          return { count };
        },
      ),
    },
    knowledgeTriageDecision: {
      findFirst: jest.fn(
        async ({ where }: { where: Where }) =>
          decisions.find((decision) => matches(decision, where)) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Where }) => {
        const decision = { id: `decision-${decisions.length + 1}`, ...data };
        decisions.push(decision);

        return { id: decision.id };
      }),
    },
    pageEntryRelation: {
      upsert: jest.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { fromId_toId: { fromId: string; toId: string } };
          create: Where;
          update: Where;
        }) => {
          const existing = relations.find(
            (relation) =>
              relation.fromId === where.fromId_toId.fromId &&
              relation.toId === where.fromId_toId.toId,
          );

          if (existing) {
            Object.assign(existing, update);
          } else {
            relations.push({ ...create });
          }
        },
      ),
    },
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        USERS[where.id] ? { type: USERS[where.id] } : null,
      ),
    },
    agentRun: {
      findMany: jest.fn(
        async ({
          where,
          select,
        }: {
          where: Where;
          select: {
            issue: { select: { comments: { where: Where } } };
          };
        }) =>
          (options.runs ?? [])
            .filter((run) => matches(run as never, where))
            .map((run) => ({
              ...run,
              issue: {
                ...run.issue,
                comments: run.issue.comments.filter((comment) =>
                  matches(comment, select.issue.select.comments.where),
                ),
              },
            })),
      ),
    },
    issue: {
      findMany: jest.fn(
        async ({
          where,
          select,
        }: {
          where: Where;
          select: { comments: { where: Where } };
        }) =>
          (options.issues ?? [])
            .filter((issue) => matches(issue as never, where))
            .map((issue) => ({
              ...issue,
              comments: (issue.comments ?? []).filter((comment) =>
                matches(comment, select.comments.where),
              ),
            })),
      ),
    },
    issueComment: {
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        (options.comments ?? []).filter((comment) =>
          matches(comment as never, where),
        ),
      ),
    },
    knowledgeBackoffChange: {
      // The latest change for the type is its state.
      findFirst: jest.fn(
        async ({ where }: { where: Where }) =>
          (options.backoff ?? [])
            .filter((change) => matches(change as never, where))
            .sort((a, b) => compare(b.createdAt, a.createdAt))[0] ?? null,
      ),
    },
  };
  const gaps = options.gaps ?? [];
  const prisma = {
    ...client,
    // Read after a decision is written, to answer the knowledge gaps an
    // accepted entry answers.
    pageEntryCitation: {
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        [...entries.values()]
          .flatMap((row) =>
            row.citations.map((citation) => ({
              ...citation,
              entryId: row.id,
              entry: view(row),
            })),
          )
          .filter((citation) => matches(citation, where)),
      ),
    },
    pageKnowledgeGap: {
      updateMany: jest.fn(
        async ({ where, data }: { where: Where; data: Where }) => {
          const found = gaps.filter((gap) => matches(gap, where));

          found.forEach((gap) => Object.assign(gap, data));

          return { count: found.length };
        },
      ),
    },
    // Interactive, as postgres runs it: whatever the work changed is undone
    // when it throws.
    $transaction: jest.fn(
      async (work: (tx: typeof client) => Promise<unknown>) => {
        const saved = [...entries.values()].map((row) => ({ ...row }));
        const savedDecisions = decisions.length;
        const savedRelations = relations.map((relation) => ({ ...relation }));

        try {
          return await work(client);
        } catch (error) {
          for (const row of saved) {
            Object.assign(entries.get(row.id) as Row, row);
          }
          decisions.length = savedDecisions;
          relations.splice(0, relations.length, ...savedRelations);
          throw error;
        }
      },
    ),
  };

  return { prisma, entries, decisions, relations, pages, gaps };
}

// ------------------------------------------------------------------ fixtures

function holds(path = 'apps/server/src/webhooks.ts'): Citation {
  return {
    kind: 'CODE',
    path,
    startLine: 40,
    endLine: 52,
    snippet: 'await queue.add(job, { attempts: RETRIES });',
    targetId: null,
    targetLabel: null,
    checkResult: 'HOLDS',
  };
}

/** An entry already in the bank: standing, grounded, in the server module. */
function existing(id: string, overrides: Partial<Row> = {}): Row {
  const content = overrides.content ?? `Existing fact ${id}.`;

  return {
    id,
    createdAt: at(0),
    updatedAt: at(0),
    deleted: null,
    scope: 'apps/server',
    kind: 'FACT',
    status: 'STANDING',
    moduleIds: [SERVER],
    pageId: PAGE,
    supersedesId: null,
    sourceUserId: 'agent-2',
    sourceSession: null,
    verifiedAt: null,
    corroborationCount: 0,
    citations: [holds()],
    ...overrides,
    content,
    contentHash:
      overrides.contentHash !== undefined
        ? overrides.contentHash
        : contentHashOf(content),
  };
}

const NEW_CONTENT = 'Webhook deliveries are retried by the queue worker.';

/**
 * The entry being triaged: newer, proposed, grounded, one fact, and written
 * by a person. What an agent writes is never accepted without a person yet
 * (see "secrets and outside input"), so the rest of the pipeline is
 * exercised on a person's entry.
 */
function fresh(overrides: Partial<Row> = {}): Row {
  return existing('new', {
    content: NEW_CONTENT,
    status: 'PROPOSED',
    createdAt: at(10),
    updatedAt: at(10),
    sourceUserId: 'person-1',
    ...overrides,
  });
}

/** The same, written by an agent. */
function agentEntry(overrides: Partial<Row> = {}): Row {
  return fresh({ sourceUserId: 'agent-1', ...overrides });
}

/**
 * A run of the writer's, open since before anything in the store was
 * written, on an issue written in the workspace.
 */
function run(
  overrides: Partial<Omit<Run, 'issue'>> & {
    issue?: Partial<Run['issue']>;
  } = {},
): Run {
  const { issue, ...rest } = overrides;

  return {
    id: RUN,
    workspaceId: WORKSPACE,
    agentUserId: 'agent-1',
    createdAt: at(-60),
    finishedAt: null,
    deleted: null,
    modelId: 'writer-model',
    ...rest,
    issue: {
      id: 'issue-1',
      sourceMetadata: null,
      support: null,
      team: { preferences: {} },
      linkedIssue: [],
      comments: [],
      ...issue,
    },
  };
}

function externalRun(sourceMetadata: unknown): Run {
  return run({ issue: { sourceMetadata } });
}

const ISSUE_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER_ISSUE_ID = 'aaaaaaaa-0000-4000-8000-000000000002';
const COMMENT_ID = 'bbbbbbbb-0000-4000-8000-000000000001';

/** Rich text as the editor stores it. */
function tiptap(text: string): string {
  return JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });
}

/** A citation of an issue, pull request, comment or run that holds. */
function cites(kind: string, targetId: string, targetLabel: string): Citation {
  return {
    kind,
    path: null,
    startLine: null,
    endLine: null,
    snippet: null,
    targetId,
    targetLabel,
    checkResult: 'HOLDS',
  };
}

function issueTarget(overrides: Partial<Target> = {}): Target {
  return {
    id: ISSUE_ID,
    deleted: null,
    title: 'Retry webhooks from the queue',
    description: tiptap(
      'Deliveries are retried by the worker, not the handler.',
    ),
    sourceMetadata: null,
    support: null,
    team: { workspaceId: WORKSPACE, deleted: null, preferences: {} },
    linkedIssue: [],
    ...overrides,
  };
}

function commentTarget(overrides: Partial<Target> = {}): Target {
  return {
    id: COMMENT_ID,
    deleted: null,
    body: tiptap('Confirmed in staging: the worker retries.'),
    sourceMetadata: null,
    issue: { deleted: null, team: { workspaceId: WORKSPACE, deleted: null } },
    ...overrides,
  };
}

type Answer = string | [string, string];

interface Setup {
  rows: Row[];
  /** The writing agent's runs, as the server records them. */
  runs?: Run[];
  issues?: Target[];
  comments?: Target[];
  preferences?: unknown;
  /** What the index returns as near entries. */
  near?: Array<{ entryId: string; similarity: number }> | Error;
  /** What the judges answer about a pair, by the existing entry's content. */
  pair?: (existing: string) => Answer;
  /** What the judges answer about accepting the entry. */
  accept?: Answer;
  /** False when no model is configured. */
  llm?: boolean;
  /** One model serving both roles. */
  sameModel?: boolean;
  /** Decision types stopped or resumed in the workspace. */
  backoff?: Backoff[];
  /** Knowledge gaps, with the issues opened for them. */
  gaps?: Array<Record<string, unknown>>;
}

function triage(setup: Setup) {
  const { prisma, entries, decisions, relations, pages, gaps } = store(
    setup.rows,
    {
      runs: setup.runs ?? [],
      issues: setup.issues,
      comments: setup.comments,
      preferences: setup.preferences,
      backoff: setup.backoff,
      gaps: setup.gaps,
    },
  );
  const calls: Array<{
    role: string;
    system: string;
    prompt: string;
    temperature: number;
  }> = [];

  // Two judges are asked the same prompt; the first answer goes to the
  // first asked.
  const answer = (value: Answer, index: number) =>
    Array.isArray(value) ? value[index] : value;

  const complete: Complete = async (role, system, prompt, temperature) => {
    const index = calls.filter((call) => call.prompt === prompt).length;
    calls.push({ role, system, prompt, temperature });

    if (system.includes('NEWER claim')) {
      const existingClaim = /EXISTING claim:\n"""\n([\s\S]*?)\n"""/.exec(
        prompt,
      )?.[1];
      const reply =
        setup.pair?.(existingClaim ?? '') ??
        '{"relation": "distinct", "reason": "different subjects"}';

      return {
        text: answer(reply, index),
        model: setup.sameModel ? 'one-model' : `${role}-model`,
      };
    }

    return {
      text: answer(
        setup.accept ?? '{"verdict": "accept", "reason": "the lines say so"}',
        index,
      ),
      model: setup.sameModel ? 'one-model' : `${role}-model`,
    };
  };

  const judges = TriageJudges.using(complete, {
    configured: () => setup.llm ?? true,
    ...(setup.sameModel && { modelOf: () => 'one-model' }),
  });
  const findNearEntries = jest.fn(
    async (): Promise<Array<{ entryId: string; similarity: number }>> => {
      if (setup.near instanceof Error) {
        throw setup.near;
      }

      return setup.near ?? [];
    },
  );
  const indexer = {
    entriesChanged: jest.fn(
      async (ids: string[]): Promise<number> => ids.length,
    ),
  };

  const service = new KnowledgeTriageService(
    prisma as unknown as PrismaService,
    judges,
    { findNearEntries } as unknown as VectorService,
    indexer as unknown as KnowledgeIndexService,
  );

  return {
    service,
    prisma,
    entries,
    decisions,
    relations,
    pages,
    gaps,
    calls,
    findNearEntries,
    indexer,
  };
}

const agreed = (relation: string): Answer =>
  `{"relation": "${relation}", "reason": "both judges read it so"}`;

// --------------------------------------------------------------------- tests

describe('an exact repeat', () => {
  it('[KG-4.1] corroborates the entry it repeats, instead of standing beside it', async () => {
    const original = existing('original', {
      content: 'Webhook deliveries are retried by the queue worker.',
      corroborationCount: 2,
    });
    // Another page in the same module, and written differently only in case
    // and spacing.
    const repeat = fresh({
      content: '  webhook deliveries are   retried by the QUEUE worker. ',
      pageId: OTHER_PAGE,
      citations: [],
    });
    const t = triage({ rows: [original, repeat] });

    const outcome = await t.service.triage('new', ON);

    expect(outcome).toMatchObject({
      decision: Decision.CORROBORATE,
      reasons: [],
      applied: true,
    });
    expect(t.entries.get('original')?.corroborationCount).toBe(3);
    // Not served beside the original: the repeat leaves the inbox.
    expect(t.entries.get('new')?.status).toBe('ARCHIVED');
    expect(t.entries.get('original')).toMatchObject({
      status: 'STANDING',
      content: 'Webhook deliveries are retried by the queue worker.',
    });
    // Who said it again, and when, is the relation from the repeat.
    expect(t.relations).toEqual([
      expect.objectContaining({
        fromId: 'new',
        toId: 'original',
        type: Relation.DUPLICATE,
        decidedBy: Decider.HASH,
      }),
    ]);
    expect(t.decisions[0]).toMatchObject({
      entryId: 'new',
      decision: Decision.CORROBORATE,
      corroboratedEntryId: 'original',
      applied: true,
    });
    // Decided by the hash: no model and no index were needed.
    expect(t.calls).toEqual([]);
    expect(t.findNearEntries).not.toHaveBeenCalled();
    expect(t.indexer.entriesChanged).toHaveBeenCalledWith(['new']);
  });

  it('[KG-4.1] is looked for only in the same modules, or on the same page when the entry has none', async () => {
    const elsewhere = existing('elsewhere', {
      content: NEW_CONTENT,
      moduleIds: [WEBAPP],
    });
    const t = triage({ rows: [elsewhere, fresh()] });

    const outcome = await t.service.triage('new', ON);

    expect(outcome?.decision).not.toBe(Decision.CORROBORATE);
    expect(t.entries.get('elsewhere')?.corroborationCount).toBe(0);

    // Unscoped: the page is the neighbourhood.
    const onPage = existing('on-page', {
      content: NEW_CONTENT,
      moduleIds: [],
    });
    const offPage = existing('off-page', {
      content: NEW_CONTENT,
      moduleIds: [],
      pageId: OTHER_PAGE,
    });
    const unscoped = triage({
      rows: [offPage, onPage, fresh({ moduleIds: [], scope: null })],
    });

    await unscoped.service.triage('new', ON);

    expect(unscoped.decisions[0]).toMatchObject({
      decision: Decision.CORROBORATE,
      corroboratedEntryId: 'on-page',
    });
    expect(unscoped.entries.get('off-page')?.corroborationCount).toBe(0);
  });

  it('[KG-4.1] counts only entries that are still live, and prefers the accepted one', async () => {
    const t = triage({
      rows: [
        existing('archived', { content: NEW_CONTENT, status: 'ARCHIVED' }),
        existing('proposed', {
          content: NEW_CONTENT,
          status: 'PROPOSED',
          createdAt: at(1),
        }),
        existing('standing', { content: NEW_CONTENT, createdAt: at(2) }),
        existing('deleted', { content: NEW_CONTENT, deleted: at(3) }),
        fresh(),
      ],
    });

    await t.service.triage('new', ON);

    expect(t.decisions[0].corroboratedEntryId).toBe('standing');
    expect(t.entries.get('standing')?.corroborationCount).toBe(1);
    expect(t.entries.get('proposed')?.corroborationCount).toBe(0);
  });

  it('[KG-7.4] corroborates a consolidated entry it repeats, which is served as its page’s evidence', async () => {
    const t = triage({
      rows: [
        existing('proposed', { content: NEW_CONTENT, status: 'PROPOSED' }),
        existing('folded', {
          content: NEW_CONTENT,
          status: 'CONSOLIDATED',
          createdAt: at(1),
        }),
        fresh(),
      ],
    });

    const outcome = await t.service.triage('new', ON);

    expect(outcome).toMatchObject({
      decision: Decision.CORROBORATE,
      applied: true,
    });
    // The served one, over the one first said.
    expect(t.decisions[0].corroboratedEntryId).toBe('folded');
    expect(t.entries.get('folded')).toMatchObject({
      status: 'CONSOLIDATED',
      corroborationCount: 1,
    });
    expect(t.entries.get('proposed')?.corroborationCount).toBe(0);
    expect(t.entries.get('new')?.status).toBe('ARCHIVED');
  });

  it('[KG-4.1] of two identical entries written at once, exactly one corroborates the other', async () => {
    const first = fresh({ id: 'a', createdAt: at(5), updatedAt: at(5) });
    const second = fresh({ id: 'b', createdAt: at(5), updatedAt: at(5) });
    // In shadow mode neither leaves the inbox, so each pass sees the other.
    const t = triage({ rows: [first, second] });

    await t.service.triage('b', SHADOW);
    await t.service.triage('a', SHADOW);

    const byEntry = Object.fromEntries(
      t.decisions.map((decision) => [decision.entryId, decision]),
    );

    expect(byEntry.b).toMatchObject({
      decision: Decision.CORROBORATE,
      corroboratedEntryId: 'a',
    });
    // `a` was there first, by the order that breaks ties on time, so it has
    // nothing to repeat.
    expect(byEntry.a.decision).not.toBe(Decision.CORROBORATE);
    expect(byEntry.a.corroboratedEntryId).toBeNull();
  });
});

describe('folding in a repeat', () => {
  it.each<[string, (row: Row) => void]>([
    [
      'archived',
      (row) => {
        row.status = 'ARCHIVED';
      },
    ],
    [
      'deleted',
      (row) => {
        row.deleted = at(11);
      },
    ],
    [
      'reworded',
      (row) => {
        row.content = 'Webhook deliveries are dropped by the queue worker.';
        row.contentHash = contentHashOf(row.content);
      },
    ],
  ])(
    '[KG-4.1] leaves the repeat in the inbox when what it repeats was %s after it was found',
    async (_change, change) => {
      const t = triage({
        rows: [existing('original', { content: NEW_CONTENT }), fresh()],
      });
      const find = t.prisma.pageEntry.findMany.getMockImplementation();
      // The first read is the look for repeats; the change lands after it.
      t.prisma.pageEntry.findMany.mockImplementationOnce(async (args) => {
        const found = await find?.(args);
        change(t.entries.get('original') as Row);

        return found ?? [];
      });

      const outcome = await t.service.triage('new', ON);

      expect(outcome).toMatchObject({
        decision: Decision.CORROBORATE,
        applied: false,
      });
      // Not archived as a repeat of something no longer there to repeat.
      expect(t.entries.get('new')?.status).toBe('PROPOSED');
      expect(t.entries.get('original')?.corroborationCount).toBe(0);
      expect(t.decisions).toHaveLength(1);
      expect(t.decisions[0]).toMatchObject({
        applied: false,
        outputs: {
          notApplied:
            'the entry it repeats, original, changed while it was triaged',
        },
      });
      expect(t.relations).toEqual([
        expect.objectContaining({ toId: 'original', type: Relation.DUPLICATE }),
      ]);
      expect(t.indexer.entriesChanged).not.toHaveBeenCalled();
    },
  );
});

describe('near neighbours', () => {
  const neighbourText = 'The queue worker retries webhook deliveries.';

  it('[KG-4.2] asks only about neighbours above the configured threshold, and keeps the answer as a link', async () => {
    const neighbour = existing('neighbour', { content: neighbourText });
    const t = triage({
      rows: [neighbour, fresh()],
      preferences: { knowledge: { similarityThreshold: 0.6 } },
      near: [{ entryId: 'neighbour', similarity: 0.82 }],
      pair: () => agreed('refines'),
    });

    await t.service.triage('new', ON);

    // The threshold is the workspace's setting, handed to the index.
    expect(t.findNearEntries).toHaveBeenCalledWith(WORKSPACE, NEW_CONTENT, {
      moduleIds: [SERVER],
      pageId: PAGE,
      minSimilarity: 0.6,
    });
    expect(t.relations).toEqual([
      expect.objectContaining({
        fromId: 'new',
        toId: 'neighbour',
        type: Relation.REFINES,
        decidedBy: Decider.MODEL,
        models: ['fast-model', 'smart-model'],
        similarity: 0.82,
      }),
    ]);
    // Link, don't edit: the neighbour's text and status are as they were.
    expect(t.entries.get('neighbour')).toMatchObject({
      content: neighbourText,
      status: 'STANDING',
    });
    const pairCalls = t.calls.filter((call) =>
      call.system.includes('NEWER claim'),
    );
    expect(pairCalls).toHaveLength(2);
    expect(pairCalls[0].prompt).toContain(neighbourText);
    expect(pairCalls[0].prompt).toContain(NEW_CONTENT);
  });

  it('[KG-4.2] compares only proposed and standing entries of the neighbourhood that were there first', async () => {
    const t = triage({
      rows: [
        existing('standing', { content: neighbourText }),
        existing('proposed', {
          content: 'The queue worker retries each webhook delivery.',
          status: 'PROPOSED',
        }),
        existing('archived', {
          content: 'Webhook deliveries retry in the worker.',
          status: 'ARCHIVED',
        }),
        existing('other-module', {
          content: 'The worker retries webhook deliveries.',
          moduleIds: [WEBAPP],
        }),
        existing('later', {
          content: 'Webhook deliveries retry through the queue worker.',
          createdAt: at(20),
        }),
        fresh(),
      ],
      // The index is asked, but postgres decides who is a neighbour.
      near: [
        { entryId: 'archived', similarity: 0.9 },
        { entryId: 'other-module', similarity: 0.88 },
        { entryId: 'later', similarity: 0.87 },
        { entryId: 'standing', similarity: 0.8 },
        { entryId: 'proposed', similarity: 0.7 },
        { entryId: 'new', similarity: 1 },
      ],
    });

    await t.service.triage('new', ON);

    expect(t.relations.map((relation) => relation.toId).sort()).toEqual([
      'proposed',
      'standing',
    ]);
  });

  it('[KG-4.2] compares with the nearest three at most', async () => {
    const rows = ['n1', 'n2', 'n3', 'n4'].map((id) =>
      existing(id, { content: `The queue worker retries webhooks (${id}).` }),
    );
    // Numbers in the ids would make them rule-distinct; strip them.
    rows.forEach((row) => {
      row.content = row.content.replace(/\d/g, '');
    });
    const t = triage({
      rows: [...rows, fresh()],
      near: [
        { entryId: 'n4', similarity: 0.5 },
        { entryId: 'n1', similarity: 0.9 },
        { entryId: 'n3', similarity: 0.7 },
        { entryId: 'n2', similarity: 0.8 },
      ],
    });

    await t.service.triage('new', ON);

    expect(t.relations.map((relation) => relation.toId)).toEqual([
      'n1',
      'n2',
      'n3',
    ]);
  });

  it.each([
    [
      'a number',
      'Sessions expire after 30 minutes.',
      'Sessions expire after 60 minutes.',
    ],
    [
      'a date',
      'Deploys are frozen on Friday.',
      'Deploys are frozen on Thursday.',
    ],
    [
      'a negation',
      'The worker retries failed webhook deliveries.',
      'The worker never retries failed webhook deliveries.',
    ],
    [
      'a condition',
      'The cache is flushed on deploy.',
      'The cache is flushed only on deploy.',
    ],
  ])(
    '[KG-4.2] keeps two entries that differ in %s as distinct, without asking a model',
    async (_what, before, after) => {
      const t = triage({
        rows: [
          existing('neighbour', { content: before }),
          fresh({ content: after }),
        ],
        near: [{ entryId: 'neighbour', similarity: 0.97 }],
        pair: () => agreed('duplicate'),
      });

      await t.service.triage('new', ON);

      expect(t.relations).toEqual([
        expect.objectContaining({
          toId: 'neighbour',
          type: Relation.DISTINCT,
          decidedBy: Decider.RULE,
        }),
      ]);
      expect(
        t.calls.filter((call) => call.system.includes('NEWER claim')),
      ).toEqual([]);
      // Nothing was folded into the neighbour.
      expect(t.entries.get('neighbour')?.corroborationCount).toBe(0);
    },
  );

  it.each([
    [
      'unreadable',
      ['It is basically the same thing, I think.', agreed('duplicate')],
    ],
    [
      'not a relation',
      ['{"relation": "similar", "reason": "close"}', agreed('duplicate')],
    ],
    // Two unreadable answers are both read as DISTINCT, but they are not two
    // judgments that agree.
    ['two unreadable', ['same', 'the same']],
  ])(
    '[KG-4.2] reads %s judge output as DISTINCT, and escalates rather than accept',
    async (_what, answers) => {
      const t = triage({
        rows: [existing('neighbour', { content: neighbourText }), fresh()],
        near: [{ entryId: 'neighbour', similarity: 0.9 }],
        pair: () => answers as [string, string],
      });

      const outcome = await t.service.triage('new', ON);

      expect(t.relations).toEqual([
        expect.objectContaining({
          toId: 'neighbour',
          type: Relation.DISTINCT,
          decidedBy: Decider.MODEL,
        }),
      ]);
      expect(outcome).toMatchObject({
        decision: Decision.ESCALATE,
        reasons: [Reason.JUDGES_DISAGREE],
      });
      expect(t.entries.get('neighbour')?.corroborationCount).toBe(0);
      expect(t.entries.get('new')?.status).toBe('PROPOSED');
    },
  );

  it('[KG-4.2] folds a near duplicate both judges agree on into the entry it repeats', async () => {
    const t = triage({
      rows: [existing('neighbour', { content: neighbourText }), fresh()],
      near: [{ entryId: 'neighbour', similarity: 0.93 }],
      pair: () => agreed('duplicate'),
    });

    const outcome = await t.service.triage('new', ON);

    expect(outcome).toMatchObject({ decision: Decision.CORROBORATE });
    expect(t.entries.get('neighbour')).toMatchObject({
      corroborationCount: 1,
      content: neighbourText,
    });
    expect(t.relations[0]).toMatchObject({
      type: Relation.DUPLICATE,
      decidedBy: Decider.MODEL,
    });
  });

  it('[KG-4.2] folds in nothing when the near duplicate was reworded while the judges answered', async () => {
    const reworded = 'The queue worker retries webhook deliveries twice.';
    const t = triage({
      rows: [existing('neighbour', { content: neighbourText }), fresh()],
      near: [{ entryId: 'neighbour', similarity: 0.93 }],
      pair: () => {
        (t.entries.get('neighbour') as Row).content = reworded;

        return agreed('duplicate');
      },
    });

    const outcome = await t.service.triage('new', ON);

    expect(outcome).toMatchObject({
      decision: Decision.CORROBORATE,
      applied: false,
    });
    expect(t.entries.get('neighbour')).toMatchObject({
      corroborationCount: 0,
      content: reworded,
    });
    expect(t.entries.get('new')?.status).toBe('PROPOSED');
  });
});

describe('the triage job and its record', () => {
  it('[KG-4.3] records an acceptance with its inputs, the models asked and what they answered', async () => {
    const t = triage({
      rows: [
        existing('neighbour', { content: 'The webapp polls for updates.' }),
        fresh(),
      ],
      near: [{ entryId: 'neighbour', similarity: 0.4 }],
    });

    const outcome = await t.service.triage('new', ON);

    expect(outcome).toMatchObject({
      decisionId: t.decisions[0].id,
      decision: Decision.AUTO_ACCEPT,
      reasons: [],
      policy: null,
      mode: KnowledgeTriageMode.ON,
      applied: true,
    });

    const [decision] = t.decisions;
    expect(decision).toMatchObject({
      entryId: 'new',
      workspaceId: WORKSPACE,
      decision: Decision.AUTO_ACCEPT,
      reasons: [],
      policy: null,
      mode: KnowledgeTriageMode.ON,
      applied: true,
      // The pair was asked about, then acceptance: every model, in order.
      models: ['fast-model', 'smart-model', 'fast-model', 'smart-model'],
    });
    expect(decision.inputs).toMatchObject({
      contentHash: contentHashOf(NEW_CONTENT),
      kind: 'FACT',
      moduleIds: [SERVER],
      citations: [{ kind: 'CODE', result: 'HOLDS' }],
      similarityThreshold: 0.25,
      writer: {
        userId: 'person-1',
        userType: 'User',
        runs: [],
        externalSource: null,
        unknownSource: false,
      },
      cited: [],
      repeats: null,
      neighbours: [
        expect.objectContaining({
          id: 'neighbour',
          similarity: 0.4,
          trust: 'GROUNDED',
          relation: Relation.DISTINCT,
        }),
      ],
    });
    expect(decision.inputsDigest).toBe(digestOf(decision.inputs));
    // The raw answers are kept as they came back.
    expect(decision.outputs).toMatchObject({
      pairs: [
        {
          with: 'neighbour',
          judgments: [
            expect.objectContaining({
              raw: '{"relation": "distinct", "reason": "different subjects"}',
            }),
            expect.anything(),
          ],
        },
      ],
      accept: [
        expect.objectContaining({
          accept: true,
          model: 'fast-model',
          raw: '{"verdict": "accept", "reason": "the lines say so"}',
        }),
        expect.objectContaining({ accept: true, model: 'smart-model' }),
      ],
    });
    // The judges were shown what the citation reads, as the server read it.
    const acceptCall = t.calls.find((call) =>
      call.system.includes('knowledge'),
    );
    expect(acceptCall?.prompt).toContain('apps/server/src/webhooks.ts:40-52');
    expect(acceptCall?.prompt).toContain(
      'await queue.add(job, { attempts: RETRIES });',
    );
    expect(t.entries.get('new')?.status).toBe('STANDING');
    expect(t.indexer.entriesChanged).toHaveBeenCalledWith(['new']);
  });

  it('[KG-4.3] records an escalation with every reason that applied', async () => {
    const t = triage({
      rows: [fresh({ citations: [], kind: 'CONVENTION' })],
    });

    const outcome = await t.service.triage('new', ON);

    expect(outcome?.decision).toBe(Decision.ESCALATE);
    expect([...(t.decisions[0].reasons as string[])].sort()).toEqual(
      [Reason.PIN_REQUEST, Reason.UNGROUNDED].sort(),
    );
    expect(t.decisions[0].applied).toBe(false);
    // An escalation waits for a person.
    expect(t.entries.get('new')?.status).toBe('PROPOSED');
    // No model was asked to accept what a person has to look at anyway.
    expect(t.calls).toEqual([]);
  });

  it('[KG-4.3] decides once per entry', async () => {
    const t = triage({ rows: [fresh({ citations: [] })] });

    expect(await t.service.triage('new', SHADOW)).not.toBeNull();
    expect(await t.service.triage('new', SHADOW)).toBeNull();

    expect(t.decisions).toHaveLength(1);
  });

  it('[KG-4.3] leaves alone an entry that is gone or no longer in the inbox', async () => {
    const t = triage({
      rows: [existing('standing'), fresh({ id: 'deleted', deleted: at(11) })],
    });

    expect(await t.service.triage('standing', ON)).toBeNull();
    expect(await t.service.triage('deleted', ON)).toBeNull();
    expect(await t.service.triage('missing', ON)).toBeNull();
    expect(t.decisions).toEqual([]);
  });

  it('[KG-4.3] fails, to be tried again, when the index cannot be asked for neighbours', async () => {
    const t = triage({
      rows: [fresh()],
      near: new Error('typesense is down'),
    });

    await expect(t.service.triage('new', ON)).rejects.toThrow(
      'typesense is down',
    );
    // Nothing is decided blind.
    expect(t.decisions).toEqual([]);
    expect(t.entries.get('new')?.status).toBe('PROPOSED');
  });

  it('[KG-4.3] acts on nothing that changed while it was deciding', async () => {
    const t = triage({ rows: [fresh()] });
    // Someone rewords the entry between the read and the decision.
    t.prisma.pageEntry.findFirst.mockImplementationOnce(async () => {
      const row = t.entries.get('new') as Row;
      const read = {
        ...row,
        page: { workspaceId: WORKSPACE, workspace: { preferences: {} } },
      };
      row.content = 'Something else entirely.';
      row.updatedAt = at(12);
      return read as never;
    });

    const outcome = await t.service.triage('new', ON);

    expect(outcome).toMatchObject({
      decision: Decision.AUTO_ACCEPT,
      applied: false,
    });
    expect(t.entries.get('new')?.status).toBe('PROPOSED');
    expect(t.decisions[0].outputs).toMatchObject({
      notApplied: 'the entry changed while it was triaged',
    });
    expect(t.indexer.entriesChanged).not.toHaveBeenCalled();
  });
});

describe('auto-accept', () => {
  it('[KG-4.4] accepts an entry only when every condition holds', async () => {
    const t = triage({ rows: [fresh()] });

    const outcome = await t.service.triage('new', ON);

    expect(outcome).toMatchObject({
      decision: Decision.AUTO_ACCEPT,
      applied: true,
    });
    expect(t.entries.get('new')?.status).toBe('STANDING');
  });

  const cases: Array<[string, Partial<Setup>, Partial<Row>, Reason[]]> = [
    ['it cites nothing', {}, { citations: [] }, [Reason.UNGROUNDED]],
    [
      'a citation no longer holds',
      {},
      { citations: [holds(), { ...holds('b.ts'), checkResult: 'CHANGED' }] },
      [Reason.CITATION_FAILED],
    ],
    [
      'a citation could not be read',
      {},
      { citations: [{ ...holds(), checkResult: 'UNKNOWN' }] },
      [Reason.CITATION_FAILED],
    ],
    [
      'it is a convention, which would be pinned',
      {},
      { kind: 'CONVENTION' },
      [Reason.PIN_REQUEST],
    ],
    [
      'its scope reaches most of the codebase',
      {},
      { moduleIds: [SERVER, WEBAPP, 'module-3', 'module-4'] },
      [Reason.BROAD_SCOPE],
    ],
    [
      'it has no scope, so every query would be served it',
      {},
      { scope: null },
      [Reason.BROAD_SCOPE],
    ],
    [
      'it asks to replace an entry',
      {},
      { supersedesId: 'someone-else' },
      [Reason.SUPERSEDE_REQUEST],
    ],
    [
      'one judge would not accept it',
      {
        accept: [
          '{"verdict": "accept", "reason": "fine"}',
          '{"verdict": "escalate", "reason": "the lines do not say that"}',
        ],
      },
      {},
      [Reason.JUDGES_DISAGREE],
    ],
    [
      'neither judge would accept it',
      { accept: '{"verdict": "escalate", "reason": "vague"}' },
      {},
      [Reason.JUDGES_DISAGREE],
    ],
    [
      'a judge answered nothing that could be read',
      { accept: ['{"verdict": "accept"}', 'Sure, looks right.'] },
      {},
      [Reason.JUDGES_DISAGREE],
    ],
  ];

  it('[KG-4.4] reads a scope over three modules as broad, and three as not', async () => {
    const t = triage({
      rows: [fresh({ moduleIds: [SERVER, WEBAPP, 'module-3'] })],
    });

    expect(await t.service.triage('new', ON)).toMatchObject({
      decision: Decision.AUTO_ACCEPT,
      reasons: [],
    });
  });

  it.each(cases)(
    '[KG-4.4] escalates when %s',
    async (_why, setup, overrides, reasons) => {
      const t = triage({ rows: [fresh(overrides)], ...setup });

      const outcome = await t.service.triage('new', ON);

      expect(outcome).toMatchObject({
        decision: Decision.ESCALATE,
        reasons,
        applied: false,
      });
      expect(t.entries.get('new')?.status).toBe('PROPOSED');
    },
  );

  it('[KG-4.4] escalates when what it contradicts was verified by a person', async () => {
    const verified = existing('verified', {
      content:
        'The queue worker drops webhook deliveries on the first failure.',
      verifiedAt: at(1),
    });
    const t = triage({
      rows: [verified, fresh()],
      near: [{ entryId: 'verified', similarity: 0.8 }],
      pair: () => agreed('contradicts'),
    });

    const outcome = await t.service.triage('new', ON);

    expect(outcome).toMatchObject({
      decision: Decision.ESCALATE,
      reasons: [Reason.CONTRADICTS_VERIFIED],
    });
    expect(t.entries.get('verified')?.status).toBe('STANDING');
    expect(t.entries.get('new')?.status).toBe('PROPOSED');
  });

  it('[KG-4.4] escalates when what it contradicts is on a locked page', async () => {
    const locked = existing('locked', {
      content:
        'The queue worker drops webhook deliveries on the first failure.',
      pageId: LOCKED_PAGE,
    });
    const t = triage({
      rows: [locked, fresh()],
      near: [{ entryId: 'locked', similarity: 0.8 }],
      pair: () => agreed('contradicts'),
    });

    const outcome = await t.service.triage('new', ON);

    expect(outcome).toMatchObject({
      decision: Decision.ESCALATE,
      reasons: [Reason.CONTRADICTS_LOCKED],
    });
    expect(t.entries.get('locked')?.status).toBe('STANDING');
  });

  it('[KG-4.4] escalates when the judges classify a pair differently', async () => {
    const t = triage({
      rows: [
        existing('neighbour', {
          content: 'The queue worker retries webhook deliveries.',
        }),
        fresh(),
      ],
      near: [{ entryId: 'neighbour', similarity: 0.9 }],
      pair: () => [
        agreed('refines') as string,
        agreed('contradicts') as string,
      ],
    });

    const outcome = await t.service.triage('new', ON);

    expect(outcome).toMatchObject({
      decision: Decision.ESCALATE,
      reasons: [Reason.JUDGES_DISAGREE],
    });
    expect(t.relations[0]).toMatchObject({ type: Relation.DISTINCT });
  });

  it('[KG-4.4] asks one model twice, at a temperature where it can disagree, when it serves both roles', async () => {
    const t = triage({ rows: [fresh()], sameModel: true });

    await t.service.triage('new', ON);

    expect(t.calls.map((call) => [call.role, call.temperature])).toEqual([
      ['smart', 0.7],
      ['smart', 0.7],
    ]);
    expect(t.decisions[0].models).toEqual(['one-model', 'one-model']);
  });
});

describe('shadow mode', () => {
  it('[KG-4.5] records what it would do and changes no status', async () => {
    const t = triage({ rows: [fresh()] });

    // Shadow is the default: no variable, no preference.
    const outcome = await t.service.triage('new', {});

    expect(outcome).toMatchObject({
      decision: Decision.AUTO_ACCEPT,
      mode: KnowledgeTriageMode.SHADOW,
      applied: false,
    });
    expect(t.decisions[0]).toMatchObject({
      mode: KnowledgeTriageMode.SHADOW,
      applied: false,
    });
    expect(t.entries.get('new')?.status).toBe('PROPOSED');
    expect(t.prisma.pageEntry.updateMany).not.toHaveBeenCalled();
    expect(t.indexer.entriesChanged).not.toHaveBeenCalled();
  });

  it('[KG-4.5] records a repeat and a contradiction without folding in or disputing anything', async () => {
    const repeat = triage({
      rows: [existing('original', { content: NEW_CONTENT }), fresh()],
    });

    await repeat.service.triage('new', SHADOW);

    expect(repeat.decisions[0]).toMatchObject({
      decision: Decision.CORROBORATE,
      corroboratedEntryId: 'original',
      applied: false,
    });
    expect(repeat.entries.get('original')?.corroborationCount).toBe(0);
    expect(repeat.entries.get('new')?.status).toBe('PROPOSED');

    const contradiction = triage({
      rows: [
        existing('older', {
          content:
            'The queue worker drops webhook deliveries on the first failure.',
        }),
        fresh(),
      ],
      near: [{ entryId: 'older', similarity: 0.8 }],
      pair: () => agreed('contradicts'),
    });

    await contradiction.service.triage('new', SHADOW);

    expect(contradiction.relations[0]).toMatchObject({
      type: Relation.CONTRADICTS,
      preferredId: 'new',
    });
    expect(contradiction.entries.get('older')?.status).toBe('STANDING');
    expect(contradiction.entries.get('new')?.status).toBe('PROPOSED');
  });

  it("[KG-4.5] follows the workspace's own setting over the deployment's", async () => {
    const on = triage({
      rows: [fresh()],
      preferences: { knowledge: { autoTriage: 'on' } },
    });
    await on.service.triage('new', SHADOW);
    expect(on.entries.get('new')?.status).toBe('STANDING');

    const off = triage({
      rows: [fresh()],
      preferences: { knowledge: { autoTriage: 'off' } },
    });
    expect(await off.service.triage('new', ON)).toBeNull();
    expect(off.decisions).toEqual([]);
    expect(off.entries.get('new')?.status).toBe('PROPOSED');
  });
});

describe('contradictions', () => {
  const contradicting =
    'The queue worker drops webhook deliveries on the first failure.';

  it('[KG-4.6] the newer of two grounded entries stands, and the older is withheld until a person looks', async () => {
    const t = triage({
      rows: [existing('older', { content: contradicting }), fresh()],
      near: [{ entryId: 'older', similarity: 0.8 }],
      // The judges' own view of which is right does not enter into it.
      pair: () =>
        '{"relation": "contradicts", "reason": "the existing claim is the correct one"}',
    });

    const outcome = await t.service.triage('new', ON);

    expect(outcome).toMatchObject({
      decision: Decision.AUTO_ACCEPT,
      applied: true,
    });
    expect(t.relations[0]).toMatchObject({
      toId: 'older',
      type: Relation.CONTRADICTS,
      preferredId: 'new',
    });
    expect(t.entries.get('new')?.status).toBe('STANDING');
    // Disputed, which a person can reverse; its text is untouched.
    expect(t.entries.get('older')).toMatchObject({
      status: 'DISPUTED',
      content: contradicting,
    });
    expect(t.indexer.entriesChanged).toHaveBeenCalledWith(['new', 'older']);
  });

  it('[KG-7.4] withholds a consolidated entry an accepted one wins against, as it would a standing one', async () => {
    const t = triage({
      rows: [
        existing('folded', { content: contradicting, status: 'CONSOLIDATED' }),
        fresh(),
      ],
      near: [{ entryId: 'folded', similarity: 0.8 }],
      pair: () => '{"relation": "contradicts", "reason": "they disagree"}',
    });

    const outcome = await t.service.triage('new', ON);

    expect(outcome).toMatchObject({
      decision: Decision.AUTO_ACCEPT,
      applied: true,
    });
    expect(t.relations[0]).toMatchObject({
      toId: 'folded',
      type: Relation.CONTRADICTS,
      preferredId: 'new',
    });
    expect(t.entries.get('folded')).toMatchObject({
      status: 'DISPUTED',
      content: contradicting,
    });
  });

  it('[KG-4.6] a verified entry outranks a newer grounded one', async () => {
    const t = triage({
      rows: [
        existing('verified', { content: contradicting, verifiedAt: at(1) }),
        fresh(),
      ],
      near: [{ entryId: 'verified', similarity: 0.8 }],
      pair: () =>
        '{"relation": "contradicts", "reason": "the newer claim is the correct one"}',
    });

    await t.service.triage('new', ON);

    expect(t.relations[0]).toMatchObject({ preferredId: 'verified' });
    expect(t.entries.get('verified')?.status).toBe('STANDING');
  });

  it('[KG-4.6] a grounded entry outranks a newer ungrounded one', async () => {
    const t = triage({
      rows: [
        existing('grounded', { content: contradicting }),
        fresh({ citations: [] }),
      ],
      near: [{ entryId: 'grounded', similarity: 0.8 }],
      pair: () => agreed('supersedes'),
    });

    const outcome = await t.service.triage('new', ON);

    expect(t.relations[0]).toMatchObject({
      type: Relation.SUPERSEDES,
      preferredId: 'grounded',
    });
    expect(outcome?.decision).toBe(Decision.ESCALATE);
    expect(t.entries.get('grounded')?.status).toBe('STANDING');
  });

  it('[KG-4.6] a proposed entry it outranks is left for its own triage', async () => {
    const t = triage({
      rows: [
        existing('proposed', { content: contradicting, status: 'PROPOSED' }),
        fresh(),
      ],
      near: [{ entryId: 'proposed', similarity: 0.8 }],
      pair: () => agreed('contradicts'),
    });

    await t.service.triage('new', ON);

    expect(t.relations[0]).toMatchObject({ preferredId: 'new' });
    expect(t.entries.get('proposed')?.status).toBe('PROPOSED');
  });

  // Each change lands while the judges are answering, which is the window in
  // which a person can act on the entry being contradicted.
  it.each<[string, (t: ReturnType<typeof triage>) => void, string]>([
    [
      'verified by a person',
      (t) => {
        (t.entries.get('older') as Row).verifiedAt = at(11);
      },
      'STANDING',
    ],
    [
      'reworded so it no longer says that',
      (t) => {
        (t.entries.get('older') as Row).content =
          'The queue worker retries webhook deliveries with backoff.';
      },
      'STANDING',
    ],
    [
      'on a page that was locked',
      (t) => {
        (t.pages.get(PAGE) as PageRow).entryPolicy = 'LOCKED';
      },
      'STANDING',
    ],
    [
      'archived by a person',
      (t) => {
        (t.entries.get('older') as Row).status = 'ARCHIVED';
      },
      'ARCHIVED',
    ],
  ])(
    '[KG-4.6] disputes nothing, and accepts nothing, when what it contradicts was %s while it decided',
    async (_change, change, olderStatus) => {
      const t = triage({
        rows: [existing('older', { content: contradicting }), fresh()],
        near: [{ entryId: 'older', similarity: 0.8 }],
        pair: () => {
          change(t);

          return agreed('contradicts');
        },
      });

      const outcome = await t.service.triage('new', ON);

      expect(outcome).toMatchObject({
        decision: Decision.AUTO_ACCEPT,
        applied: false,
      });
      expect(t.entries.get('older')?.status).toBe(olderStatus);
      expect(t.entries.get('new')?.status).toBe('PROPOSED');
      expect(t.decisions).toHaveLength(1);
      expect(t.decisions[0]).toMatchObject({
        applied: false,
        outputs: {
          notApplied:
            'the entry it contradicts, older, changed while it was triaged',
        },
      });
      // What was found is still recorded.
      expect(t.relations[0]).toMatchObject({
        toId: 'older',
        type: Relation.CONTRADICTS,
        preferredId: 'new',
      });
      expect(t.indexer.entriesChanged).not.toHaveBeenCalled();
    },
  );

  it('[KG-4.6] undoes every change it made when one entry it contradicts changed', async () => {
    const t = triage({
      rows: [
        existing('first', { content: contradicting }),
        existing('second', {
          content: 'The queue worker discards failed webhook deliveries.',
        }),
        fresh(),
      ],
      near: [
        { entryId: 'first', similarity: 0.9 },
        { entryId: 'second', similarity: 0.8 },
      ],
      pair: () => {
        (t.entries.get('second') as Row).verifiedAt = at(11);

        return agreed('contradicts');
      },
    });

    const outcome = await t.service.triage('new', ON);

    expect(outcome?.applied).toBe(false);
    // The first was disputed before the second was found changed, and is
    // standing again.
    expect(t.entries.get('first')?.status).toBe('STANDING');
    expect(t.entries.get('second')?.status).toBe('STANDING');
    expect(t.entries.get('new')?.status).toBe('PROPOSED');
    expect(t.relations).toHaveLength(2);
  });
});

describe('without a model', () => {
  it('[KG-4.7] still folds in an exact repeat, which needs none', async () => {
    const t = triage({
      rows: [existing('original', { content: NEW_CONTENT }), fresh()],
      llm: false,
    });

    const outcome = await t.service.triage('new', ON);

    expect(outcome).toMatchObject({
      decision: Decision.CORROBORATE,
      applied: true,
    });
    expect(t.entries.get('original')?.corroborationCount).toBe(1);
  });

  it('[KG-4.7] still relates by rule, and escalates what needed a model instead of accepting it', async () => {
    const t = triage({
      rows: [
        existing('ruled', {
          content:
            'Webhook deliveries are retried 5 times by the queue worker.',
        }),
        existing('unjudged', {
          content: 'The queue worker retries webhook deliveries.',
        }),
        fresh(),
      ],
      near: [
        { entryId: 'ruled', similarity: 0.9 },
        { entryId: 'unjudged', similarity: 0.85 },
      ],
      llm: false,
    });

    const outcome = await t.service.triage('new', ON);

    expect(outcome).toMatchObject({
      decision: Decision.ESCALATE,
      reasons: [Reason.NO_LLM],
      applied: false,
    });
    // The rule ran; the pair that needed a model has no relation.
    expect(t.relations).toEqual([
      expect.objectContaining({
        toId: 'ruled',
        type: Relation.DISTINCT,
        decidedBy: Decider.RULE,
      }),
    ]);
    expect(t.calls).toEqual([]);
    expect(t.entries.get('new')?.status).toBe('PROPOSED');
  });

  it('[KG-4.7] never accepts a grounded entry on an acceptance check that did not run', async () => {
    const t = triage({ rows: [fresh()], llm: false });

    const outcome = await t.service.triage('new', ON);

    expect(outcome).toMatchObject({
      decision: Decision.ESCALATE,
      reasons: [Reason.NO_LLM],
    });
    expect(t.entries.get('new')?.status).toBe('PROPOSED');
  });

  it('[KG-4.7] treats a model that cannot be reached as a check that did not run', async () => {
    const t = triage({ rows: [fresh()] });
    const failing = TriageJudges.using(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    Object.assign(t.service, { judges: failing });

    const outcome = await t.service.triage('new', ON);

    expect(outcome).toMatchObject({
      decision: Decision.ESCALATE,
      reasons: [Reason.JUDGES_DISAGREE],
    });
    expect(t.entries.get('new')?.status).toBe('PROPOSED');
  });
});

describe('secrets and outside input', () => {
  // Built at run time and plainly fake, so no scanner mistakes this file for
  // a leak.
  const fakeToken = ['gh', 'p_', 'x'.repeat(36)].join('');

  it('[KG-4.8] rejects content that looks like a credential, and records the kind, never the content', async () => {
    const t = triage({
      rows: [fresh({ content: `Deploys authenticate with ${fakeToken}.` })],
    });

    const outcome = await t.service.triage('new', ON);

    expect(outcome).toMatchObject({
      decision: Decision.REJECT,
      policy: KnowledgeTriagePolicy.SECRET,
      applied: true,
    });
    expect(t.entries.get('new')?.status).toBe('ARCHIVED');
    expect(JSON.stringify(t.decisions[0])).not.toContain(fakeToken);
    expect(t.decisions[0].inputs).toMatchObject({
      policy: { secret: 'it looks like it holds a GitHub token' },
    });
    // The content went to no model and no index.
    expect(t.calls).toEqual([]);
    expect(t.findNearEntries).not.toHaveBeenCalled();
  });

  it('[KG-4.8] rejects several claims in one entry under the one-fact policy', async () => {
    const t = triage({
      rows: [
        fresh({
          content: '- Webhooks retry.\n- Sessions expire.\n- Deploys freeze.',
        }),
      ],
    });

    const outcome = await t.service.triage('new', SHADOW);

    expect(outcome).toMatchObject({
      decision: Decision.REJECT,
      policy: KnowledgeTriagePolicy.ONE_FACT,
      applied: false,
    });
    expect(t.entries.get('new')?.status).toBe('PROPOSED');
  });

  it.each([
    ['a GitHub issue sync', { type: 'github' }],
    ['email', { type: 'email' }],
    ['Discord', { type: 'discord' }],
  ])(
    '[KG-4.8] never accepts an entry from a run whose issue came from %s',
    async (_source, sourceMetadata) => {
      const t = triage({
        rows: [agentEntry()],
        runs: [externalRun(sourceMetadata)],
      });

      const outcome = await t.service.triage('new', ON);

      expect(outcome).toMatchObject({
        decision: Decision.ESCALATE,
        reasons: [Reason.EXTERNAL_INPUT, Reason.UNKNOWN_SOURCE],
        applied: false,
      });
      // Found from the server's record of the writer's runs; the entry
      // named no session.
      expect(t.decisions[0].inputs).toMatchObject({
        writer: {
          userId: 'agent-1',
          userType: 'Agent',
          session: null,
          runs: [
            {
              id: RUN,
              issueId: 'issue-1',
              externalSource: sourceMetadata.type,
              model: 'writer-model',
            },
          ],
          externalSource: sourceMetadata.type,
          unknownSource: true,
        },
      });
      expect(t.entries.get('new')?.status).toBe('PROPOSED');
    },
  );

  it('[KG-4.8] treats a support issue, and a thread synced from outside, as outside input', async () => {
    const support = externalRun({});
    support.issue.support = { id: 'ticket-1' };
    const synced = externalRun({});
    synced.issue.linkedIssue = [{ sourceData: { type: 'slack' }, sync: true }];

    for (const run of [support, synced]) {
      const t = triage({ rows: [agentEntry()], runs: [run] });

      expect((await t.service.triage('new', ON))?.reasons).toEqual([
        Reason.EXTERNAL_INPUT,
        Reason.UNKNOWN_SOURCE,
      ]);
    }
  });

  it('[KG-4.8] does not fold a repeat from outside input into what it repeats', async () => {
    const t = triage({
      rows: [existing('original', { content: NEW_CONTENT }), agentEntry()],
      runs: [externalRun({ type: 'github' })],
    });

    const outcome = await t.service.triage('new', ON);

    expect(outcome).toMatchObject({
      decision: Decision.ESCALATE,
      reasons: [Reason.EXTERNAL_INPUT],
    });
    expect(t.entries.get('original')?.corroborationCount).toBe(0);
  });

  it("[KG-4.8] never accepts an agent's entry, whatever run it had open, since what it read cannot be told", async () => {
    // A run of the same agent open when the entry was written may have
    // nothing to do with it: runs do not write with their own credential.
    const cases: Run[][] = [
      [run()],
      // A run handing work back is inside the workspace, and still no proof.
      [externalRun({ source: 'agent-run' })],
      [],
    ];

    for (const runs of cases) {
      const t = triage({ rows: [agentEntry()], runs });

      expect(await t.service.triage('new', ON)).toMatchObject({
        decision: Decision.ESCALATE,
        reasons: [Reason.UNKNOWN_SOURCE],
        applied: false,
      });
      expect(t.decisions[0].inputs).toMatchObject({
        writer: {
          userType: 'Agent',
          runs: runs.map((open) => expect.objectContaining({ id: open.id })),
          externalSource: null,
          unknownSource: true,
        },
      });
      // No model is asked to accept what a person has to look at anyway.
      expect(
        t.calls.filter((call) => call.system.includes('knowledge')),
      ).toEqual([]);
      expect(t.entries.get('new')?.status).toBe('PROPOSED');
    }

    // Nor an entry the server has no user record of, or one by an account
    // that is not a person.
    for (const sourceUserId of [null, 'unknown-user', 'system-1']) {
      const t = triage({ rows: [fresh({ sourceUserId })] });

      expect((await t.service.triage('new', ON))?.reasons).toEqual([
        Reason.UNKNOWN_SOURCE,
      ]);
    }
  });

  it('[KG-6.3] never accepts a convention the gardener proposed from review: pinning it waits for a person', async () => {
    const ranIn = (id: string): Citation => ({
      kind: 'RUN',
      path: null,
      startLine: null,
      endLine: null,
      snippet: null,
      targetId: id,
      targetLabel: `run ${id}`,
      checkResult: 'HOLDS',
    });
    // As the gardener writes it: its System bot, the runs and the code the
    // findings pointed at, all holding.
    const t = triage({
      rows: [
        fresh({
          sourceUserId: 'system-1',
          kind: 'CONVENTION',
          content:
            'Review found this in 3 separate agent runs on Server: use the logger, not console.log',
          citations: [ranIn('run-a'), ranIn('run-b'), ranIn('run-c'), holds()],
        }),
      ],
    });

    const outcome = await t.service.triage('new', ON);

    expect(outcome).toMatchObject({
      decision: Decision.ESCALATE,
      applied: false,
    });
    expect([...(outcome?.reasons ?? [])].sort()).toEqual(
      [Reason.PIN_REQUEST, Reason.UNKNOWN_SOURCE].sort(),
    );
    expect(t.entries.get('new')?.status).toBe('PROPOSED');
    expect(t.calls.filter((call) => call.system.includes('knowledge'))).toEqual(
      [],
    );
  });

  it("[KG-4.1] still folds an agent's repeat into the entry it repeats", async () => {
    // Folding a repeat in puts no new claim in front of anyone, so an unknown
    // source does not stop it; outside input does (above).
    const exact = triage({
      rows: [existing('original', { content: NEW_CONTENT }), agentEntry()],
    });
    const near = triage({
      rows: [
        existing('neighbour', {
          content: 'The queue worker retries webhook deliveries.',
        }),
        agentEntry(),
      ],
      near: [{ entryId: 'neighbour', similarity: 0.93 }],
      pair: () => agreed('duplicate'),
    });

    expect(await exact.service.triage('new', ON)).toMatchObject({
      decision: Decision.CORROBORATE,
      reasons: [],
      applied: true,
    });
    expect(exact.entries.get('original')?.corroborationCount).toBe(1);
    expect(exact.entries.get('new')?.status).toBe('ARCHIVED');
    expect(await near.service.triage('new', ON)).toMatchObject({
      decision: Decision.CORROBORATE,
      applied: true,
    });
    expect(near.entries.get('neighbour')?.corroborationCount).toBe(1);
  });

  it('[KG-4.8] reads the runs for outside input from its own record, never from the session the writer names', async () => {
    const OTHER_RUN = '99999999-2222-4333-8444-555555555555';
    // The session names an internal run, of another agent; the writer's own
    // open run is on an issue synced from GitHub.
    const named = run({ id: OTHER_RUN, agentUserId: 'agent-2' });

    for (const sourceSession of [OTHER_RUN, 'my-harness-session', null]) {
      const t = triage({
        rows: [agentEntry({ sourceSession })],
        runs: [externalRun({ type: 'github' }), named],
      });

      expect((await t.service.triage('new', ON))?.reasons).toEqual([
        Reason.EXTERNAL_INPUT,
        Reason.UNKNOWN_SOURCE,
      ]);
      expect(t.decisions[0].inputs).toMatchObject({
        writer: {
          session: sourceSession,
          runs: [expect.objectContaining({ id: RUN })],
        },
      });
      expect(
        (t.decisions[0].inputs as { writer: { runs: unknown[] } }).writer.runs,
      ).toHaveLength(1);
    }
  });

  it('[KG-4.8] reads the runs of the writer that were open when the entry was written, and no others', async () => {
    const outside = (overrides: Partial<Omit<Run, 'issue'>>) =>
      run({ ...overrides, issue: { sourceMetadata: { type: 'github' } } });
    // The entry was written at minute 10.
    const t = triage({
      rows: [agentEntry()],
      runs: [
        run(),
        outside({ id: 'finished-before', finishedAt: at(9) }),
        outside({ id: 'started-after', createdAt: at(11) }),
        outside({ id: 'another-agent', agentUserId: 'agent-2' }),
        outside({ id: 'deleted', deleted: at(1) }),
        outside({ id: 'other-workspace', workspaceId: 'workspace-2' }),
      ],
    });

    expect((await t.service.triage('new', ON))?.reasons).toEqual([
      Reason.UNKNOWN_SOURCE,
    ]);
    expect(t.decisions[0].inputs).toMatchObject({
      writer: {
        runs: [expect.objectContaining({ id: RUN })],
        externalSource: null,
      },
    });

    // Open until the moment it was written, and one started that moment,
    // both count.
    for (const edge of [
      outside({ finishedAt: at(10) }),
      outside({ createdAt: at(10) }),
    ]) {
      const atEdge = triage({ rows: [agentEntry()], runs: [run(), edge] });

      expect((await atEdge.service.triage('new', ON))?.reasons).toEqual([
        Reason.EXTERNAL_INPUT,
        Reason.UNKNOWN_SOURCE,
      ]);
    }
  });

  it('[KG-4.8] holds a person to what they wrote, not to a run', async () => {
    const t = triage({ rows: [fresh({ sourceUserId: 'person-1' })] });

    expect(await t.service.triage('new', ON)).toMatchObject({
      decision: Decision.AUTO_ACCEPT,
      reasons: [],
    });
    expect(t.decisions[0].inputs).toMatchObject({
      writer: { userType: 'User', runs: [], unknownSource: false },
    });
  });

  it('[KG-4.8] reads a comment mirrored from outside as outside input, after its link is gone too', async () => {
    const withComment = (comment: {
      createdAt: Date;
      sourceMetadata: unknown;
    }) => run({ issue: { comments: [comment], linkedIssue: [] } });
    const reasonsWith = async (comment: {
      createdAt: Date;
      sourceMetadata: unknown;
    }) => {
      const t = triage({ rows: [agentEntry()], runs: [withComment(comment)] });

      return (await t.service.triage('new', ON))?.reasons;
    };

    expect(
      await reasonsWith({
        createdAt: at(1),
        sourceMetadata: { type: 'github', id: 'account-1' },
      }),
    ).toEqual([Reason.EXTERNAL_INPUT, Reason.UNKNOWN_SOURCE]);
    // Written after the entry, so not read before it.
    expect(
      await reasonsWith({
        createdAt: at(11),
        sourceMetadata: { type: 'github' },
      }),
    ).toEqual([Reason.UNKNOWN_SOURCE]);
    // A run handing its work back is inside the workspace.
    expect(
      await reasonsWith({
        createdAt: at(1),
        sourceMetadata: { source: 'agent-run', agentRunId: RUN },
      }),
    ).toEqual([Reason.UNKNOWN_SOURCE]);
  });

  it('[KG-4.8] never accepts an entry that rests on an issue or comment from outside', async () => {
    const cases: Array<[Setup, Citation, string]> = [
      [
        {
          rows: [],
          issues: [issueTarget({ sourceMetadata: { type: 'github' } })],
        },
        cites('ISSUE', ISSUE_ID, 'ENG-4'),
        'github',
      ],
      [
        { rows: [], issues: [issueTarget({ support: { id: 'ticket-1' } })] },
        cites('ISSUE', ISSUE_ID, 'ENG-4'),
        'support',
      ],
      // An issue from inside whose thread holds a comment mirrored from
      // outside before the entry was written.
      [
        {
          rows: [],
          issues: [
            issueTarget({
              comments: [
                { createdAt: at(1), sourceMetadata: { type: 'github' } },
              ],
            }),
          ],
        },
        cites('ISSUE', ISSUE_ID, 'ENG-4'),
        'github',
      ],
      [
        {
          rows: [],
          comments: [commentTarget({ sourceMetadata: { type: 'discord' } })],
        },
        cites('COMMENT', COMMENT_ID, COMMENT_ID),
        'discord',
      ],
    ];

    for (const [setup, citation, source] of cases) {
      const t = triage({
        ...setup,
        rows: [fresh({ citations: [holds(), citation] })],
      });

      expect(await t.service.triage('new', ON)).toMatchObject({
        decision: Decision.ESCALATE,
        reasons: [Reason.EXTERNAL_INPUT],
      });
      expect(t.decisions[0].inputs).toMatchObject({
        cited: [{ id: citation.targetId, externalSource: source }],
      });
      // Its text never reached a judge.
      expect(t.calls).toEqual([]);
    }

    // A comment mirrored after the entry was written is not what it rests on.
    const later = triage({
      rows: [
        fresh({ citations: [holds(), cites('ISSUE', ISSUE_ID, 'ENG-4')] }),
      ],
      issues: [
        issueTarget({
          comments: [{ createdAt: at(11), sourceMetadata: { type: 'github' } }],
        }),
      ],
    });

    expect((await later.service.triage('new', ON))?.decision).toBe(
      Decision.AUTO_ACCEPT,
    );
  });

  it('[KG-4.8] withholds a credential in anything it shows a model', async () => {
    const t = triage({
      rows: [
        // Written before writes were checked for credentials.
        existing('neighbour', {
          content: `The queue worker signs requests with ${fakeToken}.`,
        }),
        fresh({
          citations: [
            { ...holds(), snippet: `const TOKEN = '${fakeToken}';` },
            cites('ISSUE', ISSUE_ID, 'ENG-4'),
          ],
        }),
      ],
      issues: [
        issueTarget({ description: tiptap(`Call the API with ${fakeToken}.`) }),
      ],
      near: [{ entryId: 'neighbour', similarity: 0.5 }],
    });

    await t.service.triage('new', ON);

    const pair = t.calls.filter((call) => call.system.includes('NEWER claim'));
    const accept = t.calls.filter((call) => call.system.includes('knowledge'));

    expect(pair).toHaveLength(2);
    expect(accept).toHaveLength(2);
    for (const call of t.calls) {
      expect(call.prompt).not.toContain(fakeToken);
    }
    expect(pair[0].prompt).toContain(
      'The queue worker signs requests with [withheld: GitHub token].',
    );
    expect(accept[0].prompt).toContain(
      "const TOKEN = '[withheld: GitHub token]';",
    );
    expect(accept[0].prompt).toContain(
      'Call the API with [withheld: GitHub token].',
    );
  });
});

describe('what the acceptance judges are shown', () => {
  it('[KG-4.4] the text of a cited issue or comment, not only that it exists', async () => {
    const t = triage({
      rows: [
        fresh({
          citations: [
            cites('ISSUE', ISSUE_ID, 'ENG-4'),
            cites('COMMENT', COMMENT_ID, COMMENT_ID),
            // In another workspace, so not shown.
            cites('ISSUE', OTHER_ISSUE_ID, 'OPS-9'),
            cites(
              'PULL_REQUEST',
              'cccccccc-0000-4000-8000-000000000001',
              'https://github.com/acme/app/pull/7',
            ),
          ],
        }),
      ],
      issues: [
        issueTarget(),
        issueTarget({
          id: OTHER_ISSUE_ID,
          title: 'Not this workspace',
          team: { workspaceId: 'workspace-2', deleted: null, preferences: {} },
        }),
      ],
      comments: [commentTarget()],
    });

    await t.service.triage('new', ON);

    const [accept] = t.calls.filter((call) =>
      call.system.includes('knowledge'),
    );

    expect(accept.prompt).toContain(
      'issue ENG-4 (holds)\nRetry webhooks from the queue\n\nDeliveries are retried by the worker, not the handler.',
    );
    expect(accept.prompt).toContain(
      `comment ${COMMENT_ID} (holds)\nConfirmed in staging: the worker retries.`,
    );
    expect(accept.prompt).toContain(
      'issue OPS-9 (holds); its text is not shown',
    );
    expect(accept.prompt).not.toContain('Not this workspace');
    expect(accept.prompt).toContain(
      'pull request https://github.com/acme/app/pull/7 (holds); its text is not shown',
    );
  });

  it('[KG-4.4] no more of a cited issue than one screen of it', async () => {
    const t = triage({
      rows: [fresh({ citations: [cites('ISSUE', ISSUE_ID, 'ENG-4')] })],
      issues: [issueTarget({ description: tiptap('word '.repeat(1_000)) })],
    });

    await t.service.triage('new', ON);

    const [accept] = t.calls.filter((call) =>
      call.system.includes('knowledge'),
    );
    const shown = /issue ENG-4 \(holds\)\n([\s\S]*?) \[cut\]/.exec(
      accept.prompt,
    )?.[1];

    expect(shown).toHaveLength(MAX_CITED_TEXT);
  });
});

describe('audits', () => {
  const fakeToken = ['gh', 'p_', 'x'.repeat(36)].join('');
  const atRate = (rate: string, mode = ON) => ({
    ...mode,
    KNOWLEDGE_AUDIT_RATE: rate,
  });

  it('[KG-5.2] draws a share of what it accepts for audit, by the decision id', async () => {
    for (let index = 0; index < 20; index++) {
      const t = triage({ rows: [fresh()] });

      const outcome = await t.service.triage('new', atRate('0.5'));
      const [decision] = t.decisions as Array<{
        id: string;
        audit: boolean;
        auditRate: number | null;
      }>;

      expect(outcome).toMatchObject({
        decision: Decision.AUTO_ACCEPT,
        applied: true,
        audit: decision.audit,
      });
      // Whether it is audited can be worked out again from its id alone.
      expect(decision.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(decision.audit).toBe(auditDraw(decision.id) < 0.5);
      expect(decision.auditRate).toBe(0.5);
    }
  });

  it('[KG-5.2] audits at KNOWLEDGE_AUDIT_RATE, a tenth unless told otherwise', async () => {
    const always = triage({ rows: [fresh()] });
    await always.service.triage('new', atRate('1'));
    expect(always.decisions[0]).toMatchObject({ audit: true, auditRate: 1 });

    const never = triage({ rows: [fresh()] });
    await never.service.triage('new', atRate('0'));
    expect(never.decisions[0]).toMatchObject({ audit: false, auditRate: 0 });

    const unset = triage({ rows: [fresh()] });
    await unset.service.triage('new', ON);
    expect(unset.decisions[0]).toMatchObject({ auditRate: 0.1 });

    // The workspace's own rate over the deployment's.
    const own = triage({
      rows: [fresh()],
      preferences: { knowledge: { auditRate: 1 } },
    });
    await own.service.triage('new', atRate('0'));
    expect(own.decisions[0]).toMatchObject({ audit: true, auditRate: 1 });
  });

  it('[KG-5.2] audits folded repeats and policy refusals it acted on too', async () => {
    const repeat = triage({
      rows: [
        existing('original', { content: NEW_CONTENT }),
        fresh({ citations: [] }),
      ],
    });
    await repeat.service.triage('new', atRate('1'));
    expect(repeat.decisions[0]).toMatchObject({
      decision: Decision.CORROBORATE,
      applied: true,
      audit: true,
    });

    const several = triage({
      rows: [
        fresh({
          content: '- Webhooks retry.\n- Sessions expire.\n- Deploys freeze.',
        }),
      ],
    });
    await several.service.triage('new', atRate('1'));
    expect(several.decisions[0]).toMatchObject({
      decision: Decision.REJECT,
      policy: KnowledgeTriagePolicy.ONE_FACT,
      audit: true,
    });
  });

  it('[KG-5.2] never audits what reaches a person anyway, or a refused credential', async () => {
    // In shadow mode everything waits for a person.
    const shadow = triage({ rows: [fresh()] });
    await shadow.service.triage('new', atRate('1', SHADOW));
    expect(shadow.decisions[0]).toMatchObject({
      decision: Decision.AUTO_ACCEPT,
      applied: false,
      audit: false,
      auditRate: null,
    });

    const escalated = triage({ rows: [fresh({ citations: [] })] });
    await escalated.service.triage('new', atRate('1'));
    expect(escalated.decisions[0]).toMatchObject({
      decision: Decision.ESCALATE,
      audit: false,
      auditRate: null,
    });

    // Refused, and not put in front of anyone else.
    const secret = triage({
      rows: [fresh({ content: `Deploys authenticate with ${fakeToken}.` })],
    });
    await secret.service.triage('new', atRate('1'));
    expect(secret.decisions[0]).toMatchObject({
      decision: Decision.REJECT,
      policy: KnowledgeTriagePolicy.SECRET,
      applied: true,
      audit: false,
      auditRate: null,
    });

    // Not acted on, because the entry changed while it was decided.
    const stale = triage({ rows: [fresh()] });
    stale.prisma.pageEntry.findFirst.mockImplementationOnce(async () => {
      const row = stale.entries.get('new') as Row;
      const read = {
        ...row,
        page: { workspaceId: WORKSPACE, workspace: { preferences: {} } },
      };
      row.updatedAt = at(12);
      return read as never;
    });
    await stale.service.triage('new', atRate('1'));
    expect(stale.decisions[0]).toMatchObject({ applied: false, audit: false });
  });
});

describe('backing off', () => {
  const fakeToken = ['gh', 'p_', 'x'.repeat(36)].join('');
  const stopped = (decision: string, minutes = -5): Backoff => ({
    workspaceId: WORKSPACE,
    decision,
    backedOff: true,
    createdAt: at(minutes),
  });

  it('[KG-5.4] escalates what a backed-off type would have decided, and says what it was', async () => {
    const t = triage({
      rows: [fresh()],
      backoff: [stopped(Decision.AUTO_ACCEPT)],
    });

    const outcome = await t.service.triage('new', {
      ...ON,
      KNOWLEDGE_AUDIT_RATE: '1',
    });

    expect(outcome).toMatchObject({
      decision: Decision.ESCALATE,
      reasons: [Reason.LOW_AGREEMENT],
      backedOffFrom: Decision.AUTO_ACCEPT,
      applied: false,
      audit: false,
    });
    expect(t.decisions[0]).toMatchObject({
      decision: Decision.ESCALATE,
      reasons: [Reason.LOW_AGREEMENT],
      backedOffFrom: Decision.AUTO_ACCEPT,
    });
    // Waits for a person.
    expect(t.entries.get('new')?.status).toBe('PROPOSED');
  });

  it('[KG-5.4] acts again once the type resumes, and only on its own workspace', async () => {
    const resumed = triage({
      rows: [fresh()],
      backoff: [
        stopped(Decision.AUTO_ACCEPT, -5),
        { ...stopped(Decision.AUTO_ACCEPT, -1), backedOff: false },
      ],
    });
    expect(await resumed.service.triage('new', ON)).toMatchObject({
      decision: Decision.AUTO_ACCEPT,
      backedOffFrom: null,
      applied: true,
    });

    const elsewhere = triage({
      rows: [fresh()],
      backoff: [
        { ...stopped(Decision.AUTO_ACCEPT), workspaceId: 'workspace-2' },
      ],
    });
    expect(await elsewhere.service.triage('new', ON)).toMatchObject({
      decision: Decision.AUTO_ACCEPT,
      applied: true,
    });

    // Another type backed off leaves this one acting.
    const other = triage({
      rows: [fresh()],
      backoff: [stopped(Decision.CORROBORATE)],
    });
    expect(await other.service.triage('new', ON)).toMatchObject({
      decision: Decision.AUTO_ACCEPT,
      applied: true,
    });
  });

  it('[KG-5.4] holds back a folded repeat, leaving the entry it repeats uncounted', async () => {
    const t = triage({
      rows: [
        existing('original', { content: NEW_CONTENT, corroborationCount: 2 }),
        fresh({ citations: [] }),
      ],
      backoff: [stopped(Decision.CORROBORATE)],
    });

    expect(await t.service.triage('new', ON)).toMatchObject({
      decision: Decision.ESCALATE,
      reasons: [Reason.LOW_AGREEMENT],
      backedOffFrom: Decision.CORROBORATE,
      applied: false,
    });
    expect(t.decisions[0]).toMatchObject({ corroboratedEntryId: null });
    expect(t.entries.get('new')?.status).toBe('PROPOSED');
    expect(t.entries.get('original')?.corroborationCount).toBe(2);
  });

  it('[KG-5.4] holds back a one-fact refusal, but never lets a credential through', async () => {
    const several = triage({
      rows: [
        fresh({
          content: '- Webhooks retry.\n- Sessions expire.\n- Deploys freeze.',
        }),
      ],
      backoff: [stopped(Decision.REJECT)],
    });
    expect(await several.service.triage('new', ON)).toMatchObject({
      decision: Decision.ESCALATE,
      reasons: [Reason.LOW_AGREEMENT],
      backedOffFrom: Decision.REJECT,
      policy: KnowledgeTriagePolicy.ONE_FACT,
      applied: false,
    });
    expect(several.entries.get('new')?.status).toBe('PROPOSED');

    const secret = triage({
      rows: [fresh({ content: `Deploys authenticate with ${fakeToken}.` })],
      backoff: [stopped(Decision.REJECT)],
    });
    expect(await secret.service.triage('new', ON)).toMatchObject({
      decision: Decision.REJECT,
      policy: KnowledgeTriagePolicy.SECRET,
      backedOffFrom: null,
      applied: true,
    });
    expect(secret.entries.get('new')?.status).toBe('ARCHIVED');
  });

  it('[KG-5.4] records the same in shadow mode, where nothing is acted on', async () => {
    const t = triage({
      rows: [fresh()],
      backoff: [stopped(Decision.AUTO_ACCEPT)],
    });

    expect(await t.service.triage('new', SHADOW)).toMatchObject({
      decision: Decision.ESCALATE,
      backedOffFrom: Decision.AUTO_ACCEPT,
      mode: KnowledgeTriageMode.SHADOW,
      applied: false,
    });
  });
});

describe('a knowledge gap answered by an entry triage accepts', () => {
  const gap = () => ({
    id: 'gap-1',
    workspaceId: WORKSPACE,
    query: 'how are webhook deliveries retried',
    issueId: ISSUE_ID,
    answeredAt: null as Date | null,
    answeredByEntryId: null as string | null,
  });
  const answering = () =>
    fresh({ citations: [holds(), cites('ISSUE', ISSUE_ID, 'ENG-4')] });

  it('[KG-6.4] marks the gap answered when triage accepts an entry citing its issue', async () => {
    const t = triage({
      rows: [answering()],
      issues: [issueTarget()],
      gaps: [gap()],
    });

    expect(await t.service.triage('new', ON)).toMatchObject({
      decision: Decision.AUTO_ACCEPT,
      applied: true,
    });
    expect(t.gaps[0]).toMatchObject({ answeredByEntryId: 'new' });
    expect(t.gaps[0].answeredAt).toBeInstanceOf(Date);
  });

  it('[KG-6.4] leaves the gap open when triage only records its decision, or rejects the entry', async () => {
    const shadow = triage({
      rows: [answering()],
      issues: [issueTarget()],
      gaps: [gap()],
    });

    expect(await shadow.service.triage('new', SHADOW)).toMatchObject({
      decision: Decision.AUTO_ACCEPT,
      applied: false,
    });

    const rejected = triage({
      rows: [answering()],
      issues: [issueTarget()],
      gaps: [gap()],
      accept: '{"verdict": "reject", "reason": "the lines say otherwise"}',
    });

    expect((await rejected.service.triage('new', ON))?.decision).not.toBe(
      Decision.AUTO_ACCEPT,
    );

    for (const t of [shadow, rejected]) {
      expect(t.gaps[0]).toMatchObject({
        answeredAt: null,
        answeredByEntryId: null,
      });
    }
  });
});

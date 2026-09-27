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
import KnowledgeTriageService, { digestOf } from './knowledge-triage.service';
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

      if (['in', 'not', 'lt', 'hasSome'].some((op) => op in c)) {
        return (
          (!('in' in c) || (c.in as unknown[]).includes(value)) &&
          (!('not' in c) || value !== c.not) &&
          (!('lt' in c) || compare(value, c.lt) < 0) &&
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
  modelId: string | null;
  issue: {
    id: string;
    sourceMetadata: unknown;
    support: { id: string } | null;
    team: { preferences: unknown } | null;
    linkedIssue: Array<{ sourceData: unknown; sync: boolean }>;
  };
}

function store(
  rows: Row[],
  options: { runs?: Run[]; preferences?: unknown } = {},
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
    agentRun: {
      findFirst: jest.fn(
        async ({ where }: { where: { id: string; workspaceId: string } }) =>
          (options.runs ?? []).find(
            (run) =>
              run.id === where.id && run.workspaceId === where.workspaceId,
          ) ?? null,
      ),
    },
  };
  const prisma = {
    ...client,
    $transaction: jest.fn(
      async (work: (tx: typeof client) => Promise<unknown>) => work(client),
    ),
  };

  return { prisma, entries, decisions, relations };
}

// ------------------------------------------------------------------ fixtures

function holds(path = 'apps/server/src/webhooks.ts'): Citation {
  return {
    kind: 'CODE',
    path,
    startLine: 40,
    endLine: 52,
    snippet: 'await queue.add(job, { attempts: RETRIES });',
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

/** The entry being triaged: newer, proposed, grounded, one fact. */
function fresh(overrides: Partial<Row> = {}): Row {
  return existing('new', {
    content: NEW_CONTENT,
    status: 'PROPOSED',
    createdAt: at(10),
    updatedAt: at(10),
    sourceUserId: 'agent-1',
    ...overrides,
  });
}

function externalRun(sourceMetadata: unknown): Run {
  return {
    id: RUN,
    workspaceId: WORKSPACE,
    modelId: 'writer-model',
    issue: {
      id: 'issue-1',
      sourceMetadata,
      support: null,
      team: { preferences: {} },
      linkedIssue: [],
    },
  };
}

type Answer = string | [string, string];

interface Setup {
  rows: Row[];
  runs?: Run[];
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
}

function triage(setup: Setup) {
  const { prisma, entries, decisions, relations } = store(setup.rows, {
    runs: setup.runs,
    preferences: setup.preferences,
  });
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
      decisionId: 'decision-1',
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
        rows: [fresh({ sourceSession: RUN })],
        runs: [externalRun(sourceMetadata)],
      });

      const outcome = await t.service.triage('new', ON);

      expect(outcome).toMatchObject({
        decision: Decision.ESCALATE,
        reasons: [Reason.EXTERNAL_INPUT],
        applied: false,
      });
      expect(t.decisions[0].inputs).toMatchObject({
        writer: {
          runId: RUN,
          issueId: 'issue-1',
          externalSource: sourceMetadata.type,
          model: 'writer-model',
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
      const t = triage({ rows: [fresh({ sourceSession: RUN })], runs: [run] });

      expect((await t.service.triage('new', ON))?.reasons).toEqual([
        Reason.EXTERNAL_INPUT,
      ]);
    }
  });

  it('[KG-4.8] does not fold a repeat from outside input into accepted knowledge', async () => {
    const t = triage({
      rows: [
        existing('original', { content: NEW_CONTENT }),
        fresh({ sourceSession: RUN }),
      ],
      runs: [externalRun({ type: 'github' })],
    });

    const outcome = await t.service.triage('new', ON);

    expect(outcome).toMatchObject({
      decision: Decision.ESCALATE,
      reasons: [Reason.EXTERNAL_INPUT],
    });
    expect(t.entries.get('original')?.corroborationCount).toBe(0);
  });

  it('[KG-4.8] accepts from a run whose issue was written in the workspace', async () => {
    const t = triage({
      rows: [fresh({ sourceSession: RUN })],
      // A run handing work back records where it came from; that is not
      // outside the workspace.
      runs: [externalRun({ source: 'agent-run' })],
    });

    const outcome = await t.service.triage('new', ON);

    expect(outcome?.decision).toBe(Decision.AUTO_ACCEPT);
  });
});

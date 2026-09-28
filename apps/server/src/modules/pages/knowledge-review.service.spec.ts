/**
 * The review queue, people's verdicts on triage, audits, and the agreement
 * and back-off those verdicts drive.
 *
 * Built from the real services and controller over an in-memory store that
 * answers the filters they write. A write handed to a transaction runs only
 * when the transaction runs it, and a transaction that throws is undone, so
 * a verdict is seen to land with the change it was given for.
 */
import { ForbiddenException } from '@nestjs/common';
import {
  KnowledgeEscalationReason as Reason,
  KnowledgeTriageDecisionType as Decision,
  KnowledgeTriagePolicy as Policy,
  KnowledgeVerdict as Verdict,
  PageEntryMaintenanceAction as MaintenanceAction,
  PageEntryMaintenanceReason as MaintenanceReason,
  PageEntryProposalState as ProposalState,
} from '@prisma/client';
import {
  KnowledgeReviewReasonEnum,
  PageEntryStatusEnum,
  RoleEnum,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { LoggerService } from 'modules/logger/logger.service';

import { KnowledgeReviewController } from './knowledge-review.controller';
import KnowledgeReviewService from './knowledge-review.service';
import PageEntriesService from './page-entries.service';
import PagesService from './pages.service';
import KnowledgeAgreementService from './triage/knowledge-agreement.service';

const WORKSPACE = 'workspace-1';
const OTHER_WORKSPACE = 'workspace-2';
const PAGE = 'page-1';
const OTHER_PAGE = 'page-2';
const FOREIGN_PAGE = 'page-foreign';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const daysAgo = (days: number) => new Date(NOW - days * DAY);

// ----------------------------------------------------------------- the store

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function matches(row: Row, where: Where): boolean {
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

      if (['in', 'not', 'gt', 'gte', 'lt', 'lte'].some((op) => op in c)) {
        return (
          (!('in' in c) || (c.in as unknown[]).includes(value)) &&
          (!('not' in c) || value !== c.not) &&
          (!('gt' in c) || compare(value, c.gt) > 0) &&
          (!('gte' in c) || compare(value, c.gte) >= 0) &&
          (!('lt' in c) || compare(value, c.lt) < 0) &&
          (!('lte' in c) || compare(value, c.lte) <= 0)
        );
      }

      // A relation, matched against the related row.
      return (
        typeof value === 'object' && value !== null && matches(value as Row, c)
      );
    }

    return value === condition;
  });
}

function compare(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() - b.getTime();
  }

  return typeof a === 'number' && typeof b === 'number'
    ? a - b
    : String(a) < String(b)
      ? -1
      : String(a) > String(b)
        ? 1
        : 0;
}

function ordered<T extends Row>(rows: T[], orderBy?: unknown): T[] {
  const keys = (
    Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []
  ).flatMap((part) => Object.entries(part as Record<string, string>));

  return [...rows].sort((a, b) => {
    for (const [key, direction] of keys) {
      const order = compare(a[key], b[key]);

      if (order !== 0) {
        return direction === 'desc' ? -order : order;
      }
    }

    return 0;
  });
}

/** A Prisma write: runs when awaited, and only once. */
function lazy<T>(run: () => T): Promise<T> {
  let started: Promise<T> | undefined;
  const start = () => (started ??= Promise.resolve().then(run));

  return {
    then: (resolve, reject) => start().then(resolve, reject),
    catch: (reject) => start().catch(reject),
    finally: (done) => start().finally(done),
    [Symbol.toStringTag]: 'Promise',
  } as Promise<T>;
}

const USERS: Record<string, string> = {
  'person-1': 'User',
  'person-2': 'User',
  'agent-1': 'Agent',
};

interface Seed {
  entries: Row[];
  decisions?: Row[];
  backoff?: Row[];
  maintenance?: Row[];
  preferences?: Row;
}

function store(seed: Seed) {
  const workspaces = new Map<string, Row>([
    [WORKSPACE, { id: WORKSPACE, preferences: seed.preferences ?? {} }],
    [
      OTHER_WORKSPACE,
      { id: OTHER_WORKSPACE, preferences: seed.preferences ?? {} },
    ],
  ]);
  const page = (id: string, workspaceId: string): Row => ({
    id,
    workspaceId,
    deleted: null,
    title: `Page ${id}`,
    kind: 'AUTHORED',
    description: null,
    citedEntryIds: [],
    updatedAt: new Date(NOW - 60_000),
  });
  const pages = new Map<string, Row>([
    [PAGE, page(PAGE, WORKSPACE)],
    [OTHER_PAGE, page(OTHER_PAGE, WORKSPACE)],
    [FOREIGN_PAGE, page(FOREIGN_PAGE, OTHER_WORKSPACE)],
  ]);
  const proposals: Row[] = [];
  const entries = new Map(seed.entries.map((row) => [row.id as string, row]));
  const decisions = [...(seed.decisions ?? [])];
  const backoff = [...(seed.backoff ?? [])];
  const maintenance = [...(seed.maintenance ?? [])];
  let clock = NOW;

  const entryView = (row: Row) => ({
    ...row,
    page: pages.get(row.pageId as string),
    supersedes: row.supersedesId
      ? (entries.get(row.supersedesId as string) ?? null)
      : null,
    citations: [] as Row[],
  });
  const decisionView = (row: Row) => {
    const of = entries.get(row.entryId as string);

    return { ...row, entry: of ? entryView(of) : null };
  };
  const maintenanceView = decisionView;
  const apply = (row: Row, data: Row) => {
    for (const [key, value] of Object.entries(data)) {
      const step = value as { increment?: number; decrement?: number } | null;

      row[key] =
        step && typeof step === 'object' && !(step instanceof Date)
          ? (row[key] as number) + (step.increment ?? 0) - (step.decrement ?? 0)
          : value;
    }
  };

  const proposalView = (row: Row): Row => ({
    ...row,
    page: pages.get(row.pageId as string),
  });
  const client = {
    page: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        lazy(() => pages.get(where.id) ?? null),
      ),
      findFirst: jest.fn(({ where }: { where: Where }) =>
        lazy(
          () => [...pages.values()].find((row) => matches(row, where)) ?? null,
        ),
      ),
      update: jest.fn(({ where, data }: { where: { id: string }; data: Row }) =>
        lazy(() => {
          const row = pages.get(where.id) as Row;
          apply(row, data);

          return row;
        }),
      ),
    },
    pageHistory: { create: jest.fn(() => lazy(() => ({}))) },
    pageProposal: {
      create: jest.fn(({ data }: { data: Row }) =>
        lazy(() => {
          const row = {
            id: `proposal-${proposals.length + 1}`,
            createdAt: new Date(++clock),
            state: 'OPEN',
            decidedById: null as string | null,
            decidedAt: null as Date | null,
            ...data,
          };
          proposals.push(row);

          return proposalView(row);
        }),
      ),
      findFirst: jest.fn(({ where }: { where: Where }) =>
        lazy(
          () =>
            proposals.map(proposalView).find((row) => matches(row, where)) ??
            null,
        ),
      ),
      findMany: jest.fn(({ where, orderBy }: { where: Where; orderBy?: Row }) =>
        lazy(() =>
          proposals
            .map(proposalView)
            .filter((row) => matches(row, where))
            .sort(
              (a, b) =>
                ((a.createdAt as Date).getTime() -
                  (b.createdAt as Date).getTime()) *
                (orderBy?.createdAt === 'desc' ? -1 : 1),
            ),
        ),
      ),
      updateMany: jest.fn(({ where, data }: { where: Where; data: Row }) =>
        lazy(() => {
          const hit = proposals.filter((row) => matches(row, where));
          hit.forEach((row) => apply(row, data));

          return { count: hit.length };
        }),
      ),
      findUniqueOrThrow: jest.fn(({ where }: { where: { id: string } }) =>
        lazy(() =>
          proposalView(proposals.find((row) => row.id === where.id) as Row),
        ),
      ),
      // As Prisma's: a row the filter no longer matches is an error.
      update: jest.fn(({ where, data }: { where: Where; data: Row }) =>
        lazy(() => {
          const row = proposals.find((candidate) => matches(candidate, where));

          if (!row) {
            throw new Error('Record to update not found.');
          }

          apply(row, data);

          return row;
        }),
      ),
    },
    workspace: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        lazy(() => workspaces.get(where.id) ?? null),
      ),
    },
    user: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        lazy(() => (USERS[where.id] ? { type: USERS[where.id] } : null)),
      ),
    },
    usersOnWorkspaces: {
      findUnique: jest.fn(
        ({
          where,
        }: {
          where: {
            userId_workspaceId: { userId: string; workspaceId: string };
          };
        }) =>
          lazy(() =>
            USERS[where.userId_workspaceId.userId] &&
            where.userId_workspaceId.workspaceId === WORKSPACE
              ? { status: 'ACTIVE' }
              : null,
          ),
      ),
    },
    moduleRepo: { findMany: jest.fn(() => lazy((): Row[] => [])) },
    pageEntry: {
      findFirst: jest.fn(({ where }: { where: Where }) =>
        lazy(
          () =>
            [...entries.values()]
              .map(entryView)
              .find((row) => matches(row, where)) ?? null,
        ),
      ),
      findMany: jest.fn(
        ({ where, orderBy }: { where: Where; orderBy?: unknown }) =>
          lazy(() =>
            ordered(
              [...entries.values()]
                .map(entryView)
                .filter((row) => matches(row, where)),
              orderBy,
            ),
          ),
      ),
      update: jest.fn(({ where, data }: { where: { id: string }; data: Row }) =>
        lazy(() => {
          const row = entries.get(where.id) as Row;
          apply(row, { ...data, updatedAt: new Date(++clock) });

          return entryView(row);
        }),
      ),
      updateMany: jest.fn(({ where, data }: { where: Where; data: Row }) =>
        lazy(() => {
          const found = [...entries.values()].filter((row) =>
            matches(entryView(row), where),
          );
          found.forEach((row) => apply(row, data));

          return { count: found.length };
        }),
      ),
    },
    knowledgeTriageDecision: {
      findMany: jest.fn(
        ({ where, orderBy }: { where: Where; orderBy?: unknown }) =>
          lazy(() =>
            ordered(
              decisions.map(decisionView).filter((row) => matches(row, where)),
              orderBy,
            ),
          ),
      ),
      findFirst: jest.fn(({ where }: { where: Where }) =>
        lazy(
          () =>
            decisions.map(decisionView).find((row) => matches(row, where)) ??
            null,
        ),
      ),
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        lazy(() => decisions.find((row) => row.id === where.id) ?? null),
      ),
      // As Prisma's: a row the filter no longer matches is an error, which
      // rolls back the transaction it is in.
      update: jest.fn(({ where, data }: { where: Where; data: Row }) =>
        lazy(() => {
          const row = decisions.find((candidate) => matches(candidate, where));

          if (!row) {
            throw new Error('Record to update not found.');
          }

          apply(row, data);

          return row;
        }),
      ),
      updateMany: jest.fn(({ where, data }: { where: Where; data: Row }) =>
        lazy(() => {
          const found = decisions.filter((row) => matches(row, where));
          found.forEach((row) => apply(row, data));

          return { count: found.length };
        }),
      ),
    },
    knowledgeBackoffChange: {
      findFirst: jest.fn(
        ({ where, orderBy }: { where: Where; orderBy?: unknown }) =>
          lazy(
            () =>
              ordered(
                backoff.filter((row) => matches(row, where)),
                orderBy,
              )[0] ?? null,
          ),
      ),
      create: jest.fn(({ data }: { data: Row }) =>
        lazy(() => {
          const row = {
            id: `change-${backoff.length + 1}`,
            createdAt: new Date(++clock),
            ...data,
          };
          backoff.push(row);

          return row;
        }),
      ),
    },
    pageEntryMaintenance: {
      findMany: jest.fn(
        ({ where, orderBy }: { where: Where; orderBy?: unknown }) =>
          lazy(() =>
            ordered(
              maintenance
                .map(maintenanceView)
                .filter((row) => matches(row, where)),
              orderBy,
            ),
          ),
      ),
      findFirst: jest.fn(({ where }: { where: Where }) =>
        lazy(
          () =>
            maintenance
              .map(maintenanceView)
              .find((row) => matches(row, where)) ?? null,
        ),
      ),
      update: jest.fn(({ where, data }: { where: Where; data: Row }) =>
        lazy(() => {
          const row = maintenance.find((candidate) =>
            matches(candidate, where),
          );

          if (!row) {
            throw new Error('Record to update not found.');
          }

          apply(row, data);

          return row;
        }),
      ),
      updateMany: jest.fn(({ where, data }: { where: Where; data: Row }) =>
        lazy(() => {
          const found = maintenance.filter((row) => matches(row, where));
          found.forEach((row) => apply(row, data));

          return { count: found.length };
        }),
      ),
    },
    $executeRaw: jest.fn(() => lazy(() => 1)),
  };

  const snapshot = () => ({
    entries: [...entries.values()].map((row) => ({ ...row })),
    decisions: decisions.map((row) => ({ ...row })),
    backoff: backoff.length,
    maintenance: maintenance.map((row) => ({ ...row })),
  });
  const restore = (saved: ReturnType<typeof snapshot>) => {
    saved.entries.forEach((row) =>
      apply(entries.get(row.id as string) as Row, row),
    );
    decisions.splice(0, decisions.length, ...saved.decisions);
    backoff.length = saved.backoff;
    maintenance.splice(0, maintenance.length, ...saved.maintenance);
  };

  const prisma = {
    ...client,
    $transaction: jest.fn(
      async (work: unknown[] | ((tx: typeof client) => Promise<unknown>)) => {
        const saved = snapshot();

        try {
          if (typeof work === 'function') {
            return await work(client);
          }

          const results: unknown[] = [];
          for (const operation of work) {
            results.push(await operation);
          }

          return results;
        } catch (error) {
          restore(saved);
          throw error;
        }
      },
    ),
  };

  return { prisma, entries, decisions, backoff, maintenance };
}

// ------------------------------------------------------------------ fixtures

function entry(id: string, overrides: Row = {}): Row {
  return {
    id,
    pageId: PAGE,
    content: `Fact ${id}.`,
    contentHash: null,
    scope: 'apps/server',
    moduleIds: [],
    kind: 'FACT',
    status: PageEntryStatusEnum.PROPOSED,
    sourceUserId: 'agent-1',
    supersedesId: null,
    verifiedAt: null,
    verifiedByUserId: null,
    deleted: null,
    createdAt: daysAgo(2),
    updatedAt: daysAgo(2),
    ...overrides,
  };
}

function decision(entryId: string, overrides: Row = {}): Row {
  return {
    id: `decision-${entryId}`,
    createdAt: daysAgo(1),
    entryId,
    workspaceId: WORKSPACE,
    decision: Decision.ESCALATE,
    reasons: [Reason.JUDGES_DISAGREE],
    policy: null,
    mode: 'ON',
    applied: false,
    corroboratedEntryId: null,
    backedOffFrom: null,
    audit: false,
    auditRate: null,
    verdict: null,
    agreed: null,
    verdictById: null,
    verdictAt: null,
    ...overrides,
  };
}

/** A decision triage acted on, drawn for audit, and its entry as it left it. */
function audited(id: string, type: Decision, overrides: Row = {}) {
  return {
    entry: entry(id, {
      status:
        type === Decision.AUTO_ACCEPT
          ? PageEntryStatusEnum.STANDING
          : PageEntryStatusEnum.ARCHIVED,
      sourceUserId: 'person-2',
    }),
    decision: decision(id, {
      decision: type,
      reasons: [],
      applied: true,
      audit: true,
      auditRate: 0.1,
      ...overrides,
    }),
  };
}

/** A decision a person already gave a verdict on, in the window. */
function ruled(
  id: string,
  type: Decision,
  verdict: Verdict,
  overrides: Row = {},
): Row {
  return decision(id, {
    decision: type,
    reasons: type === Decision.ESCALATE ? [Reason.JUDGES_DISAGREE] : [],
    applied: type !== Decision.ESCALATE,
    verdict,
    verdictById: 'person-2',
    verdictAt: daysAgo(1),
    ...overrides,
  });
}

const ON = { knowledge: { autoTriage: 'on' } };

function harness(seed: Seed) {
  const s = store({ preferences: ON, ...seed });
  const prisma = s.prisma as unknown as PrismaService;
  const agreement = new KnowledgeAgreementService(prisma);
  const pageEntries = new PageEntriesService(
    prisma,
    undefined,
    undefined,
    undefined,
    undefined,
    agreement,
  );
  const review = new KnowledgeReviewService(prisma, pageEntries);
  const controller = new KnowledgeReviewController(review, agreement, prisma);
  const pagesService = new PagesService(prisma, undefined, agreement);

  return { ...s, agreement, pageEntries, pagesService, review, controller };
}

const decided = (t: ReturnType<typeof harness>, id: string) =>
  t.decisions.find((row) => row.id === `decision-${id}`) as Row;

// --------------------------------------------------------------------- tests

describe('the review queue', () => {
  function queued() {
    const auditedAccept = audited('accepted', Decision.AUTO_ACCEPT);
    const auditedRepeat = audited('repeat', Decision.CORROBORATE, {
      createdAt: daysAgo(0.5),
    });

    return harness({
      entries: [
        entry('ungrounded'),
        entry('judged', { createdAt: daysAgo(1) }),
        entry('both', { pageId: OTHER_PAGE }),
        entry('shadowed'),
        entry('untriaged'),
        auditedAccept.entry,
        auditedRepeat.entry,
        entry('foreign', { pageId: FOREIGN_PAGE }),
      ],
      decisions: [
        decision('ungrounded', { reasons: [Reason.UNGROUNDED] }),
        decision('judged'),
        decision('both', {
          reasons: [Reason.UNGROUNDED, Reason.BROAD_SCOPE],
        }),
        // What shadow mode would have done: no reason to give.
        decision('shadowed', {
          decision: Decision.AUTO_ACCEPT,
          reasons: [],
          mode: 'SHADOW',
        }),
        auditedAccept.decision,
        auditedRepeat.decision,
        decision('foreign', {
          workspaceId: OTHER_WORKSPACE,
          reasons: [Reason.UNGROUNDED],
        }),
      ],
    });
  }

  it('[KG-5.1] lists escalated entries with their reasons, beside audit items', async () => {
    const t = queued();

    const queue = await t.review.queue(WORKSPACE);
    const byEntry = Object.fromEntries(
      queue.items.map((item) => [item.entry.id, item]),
    );

    expect(queue.autoTriage).toBe('on');
    // The whole inbox, as before, and the audits; nothing of another
    // workspace's.
    expect(Object.keys(byEntry).sort()).toEqual([
      'accepted',
      'both',
      'judged',
      'repeat',
      'shadowed',
      'ungrounded',
      'untriaged',
    ]);
    expect(byEntry.ungrounded).toMatchObject({
      decisionId: 'decision-ungrounded',
      decision: 'ESCALATE',
      reasons: ['UNGROUNDED'],
      audit: false,
      entry: { content: 'Fact ungrounded.', status: 'PROPOSED' },
    });
    expect(byEntry.both.reasons).toEqual(['UNGROUNDED', 'BROAD_SCOPE']);
    expect(byEntry.shadowed).toMatchObject({
      decision: 'AUTO_ACCEPT',
      mode: 'SHADOW',
      reasons: [],
    });
    expect(byEntry.untriaged).toMatchObject({ decisionId: null, reasons: [] });
    expect(byEntry.accepted).toMatchObject({
      decisionId: 'decision-accepted',
      decision: 'AUTO_ACCEPT',
      reasons: ['AUDIT'],
      audit: true,
      entry: { status: 'STANDING' },
    });
    expect(byEntry.repeat).toMatchObject({
      decision: 'CORROBORATE',
      reasons: ['AUDIT'],
      entry: { status: 'ARCHIVED' },
    });

    // How many carry each reason, the most common first.
    expect(queue.reasons).toEqual([
      { reason: 'AUDIT', count: 2 },
      { reason: 'UNGROUNDED', count: 2 },
      { reason: 'BROAD_SCOPE', count: 1 },
      { reason: 'JUDGES_DISAGREE', count: 1 },
    ]);
  });

  it('[KG-5.1] narrows to the reasons asked for, and to a page', async () => {
    const t = queued();

    const ungrounded = await t.review.queue(WORKSPACE, {
      reasons: [KnowledgeReviewReasonEnum.UNGROUNDED],
    });
    expect(ungrounded.items.map((item) => item.entry.id).sort()).toEqual([
      'both',
      'ungrounded',
    ]);
    // The counts are over the whole queue, so the other reasons stay in
    // reach.
    expect(ungrounded.reasons).toHaveLength(4);

    const audits = await t.review.queue(WORKSPACE, {
      reasons: [KnowledgeReviewReasonEnum.AUDIT],
    });
    expect(audits.items.map((item) => item.entry.id)).toEqual([
      'repeat',
      'accepted',
    ]);

    const either = await t.review.queue(WORKSPACE, {
      reasons: [
        KnowledgeReviewReasonEnum.JUDGES_DISAGREE,
        KnowledgeReviewReasonEnum.BROAD_SCOPE,
      ],
    });
    expect(either.items.map((item) => item.entry.id).sort()).toEqual([
      'both',
      'judged',
    ]);

    const page = await t.review.queue(WORKSPACE, { pageId: OTHER_PAGE });
    expect(page.items.map((item) => item.entry.id)).toEqual(['both']);

    // A page of another workspace holds nothing for this one.
    expect(
      (await t.review.queue(WORKSPACE, { pageId: FOREIGN_PAGE })).items,
    ).toEqual([]);
  });

  it('[KG-7.4] lists consolidations of pages people write apart from the entries, for the page asked for', async () => {
    const standing = { status: PageEntryStatusEnum.STANDING };
    const t = harness({
      entries: [
        entry('on-page', standing),
        entry('on-other', { ...standing, pageId: OTHER_PAGE }),
        entry('foreign', { ...standing, pageId: FOREIGN_PAGE }),
        entry('waiting'),
      ],
    });
    const propose = (pageId: string) =>
      t.pagesService.consolidate(pageId, 'agent-1', {
        descriptionMarkdown: 'Folded in.',
      });
    const first = await propose(PAGE);
    const second = await propose(OTHER_PAGE);
    await propose(FOREIGN_PAGE);
    const declined = await propose(PAGE);
    await t.pagesService.declineProposal(PAGE, declined.id, 'person-1');

    const queue = await t.review.queue(WORKSPACE);
    expect(queue.pageProposals.map((row) => row.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(queue.pageProposals[1]).toMatchObject({
      pageId: PAGE,
      pageTitle: `Page ${PAGE}`,
      entryIds: ['on-page'],
      proposedById: 'agent-1',
      state: 'OPEN',
    });
    expect(queue.pageProposals[1].bodyMarkdown).toContain('Folded in.');
    // Beside the entries, not among them, and not counted as reasons.
    expect(queue.items.map((item) => item.entry.id)).toEqual(['waiting']);
    expect(queue.reasons).toEqual([]);

    expect(
      (await t.review.queue(WORKSPACE, { pageId: OTHER_PAGE })).pageProposals,
    ).toEqual([expect.objectContaining({ id: second.id })]);
    expect(
      (
        await t.review.queue(WORKSPACE, {
          reasons: [KnowledgeReviewReasonEnum.AUDIT],
        })
      ).pageProposals,
    ).toHaveLength(2);
    expect(
      (await t.review.queue(WORKSPACE, { pageId: FOREIGN_PAGE })).pageProposals,
    ).toEqual([]);

    // Answered, it leaves the queue.
    await t.pagesService.acceptProposal(PAGE, first.id, 'person-1');
    expect(
      (await t.review.queue(WORKSPACE)).pageProposals.map((row) => row.id),
    ).toEqual([second.id]);
  });

  it('[KG-5.1] drops what a person has ruled on, and audits of entries that moved on', async () => {
    const stale = audited('decayed', Decision.AUTO_ACCEPT);
    stale.entry.status = PageEntryStatusEnum.ARCHIVED;
    const done = audited('done', Decision.AUTO_ACCEPT, {
      verdict: Verdict.ACCEPTED,
    });
    const t = harness({
      entries: [entry('edited'), stale.entry, done.entry],
      decisions: [
        // Edited by a person: still in the inbox, no longer escalated.
        decision('edited', { verdict: Verdict.EDITED }),
        stale.decision,
        done.decision,
      ],
    });

    const queue = await t.review.queue(WORKSPACE);

    expect(queue.items).toEqual([
      expect.objectContaining({
        entry: expect.objectContaining({ id: 'edited' }),
        decisionId: null,
        reasons: [],
      }),
    ]);
    expect(queue.reasons).toEqual([]);
  });

  it('[KG-5.1] gives the reasons of the latest decision about an entry', async () => {
    const t = harness({
      entries: [entry('twice'), entry('settled')],
      decisions: [
        decision('twice', {
          id: 'older-twice',
          createdAt: daysAgo(3),
          reasons: [Reason.NO_LLM],
        }),
        decision('twice', { reasons: [Reason.UNGROUNDED] }),
        decision('settled', {
          id: 'older-settled',
          createdAt: daysAgo(3),
          reasons: [Reason.NO_LLM],
        }),
        decision('settled', { verdict: Verdict.EDITED }),
      ],
    });

    const queue = await t.review.queue(WORKSPACE);

    expect(
      queue.items.map((item) => [item.entry.id, item.decisionId, item.reasons]),
    ).toEqual([
      ['twice', 'decision-twice', ['UNGROUNDED']],
      ['settled', null, []],
    ]);
  });

  it('[KG-5.1] is the inbox alone, as before, when triage is off', async () => {
    const t = queued();
    const on = await t.review.queue(WORKSPACE);

    (t.prisma.workspace.findUnique as jest.Mock).mockImplementation(() =>
      lazy(() => ({ preferences: { knowledge: { autoTriage: 'off' } } })),
    );
    const off = await t.review.queue(WORKSPACE);

    // Every entry waiting, newest first, exactly as the inbox lists them.
    const inbox = [...t.entries.values()]
      .filter(
        (row) =>
          row.status === PageEntryStatusEnum.PROPOSED &&
          row.pageId !== FOREIGN_PAGE,
      )
      .sort((a, b) => compare(b.createdAt, a.createdAt))
      .map((row) => row.id);

    expect(off.autoTriage).toBe('off');
    expect(off.items.map((item) => item.entry.id)).toEqual(inbox);
    expect(off.items.every((item) => item.reasons.length === 0)).toBe(true);
    expect(off.items.every((item) => item.decisionId === null)).toBe(true);
    expect(off.reasons).toEqual([]);
    // With triage on, the same inbox, plus the audits.
    expect(
      on.items.filter((item) => !item.audit).map((item) => item.entry.id),
    ).toEqual(inbox);
  });

  it('[KG-5.1] is served to people, narrowed by ?reason=, and refused to agents', async () => {
    const t = queued();

    const queue = await t.controller.queue(
      WORKSPACE,
      'person-1',
      RoleEnum.USER,
      {
        reason: 'UNGROUNDED,AUDIT' as never,
      },
    );
    expect(queue.items.map((item) => item.entry.id).sort()).toEqual([
      'accepted',
      'both',
      'repeat',
      'ungrounded',
    ]);

    await expect(
      t.controller.queue(WORKSPACE, 'agent-1', RoleEnum.AGENT, {}),
    ).rejects.toThrow('Review is for people');
  });
});

describe('verdicts from what people do', () => {
  it('[KG-5.5] accepting an escalated entry resolves it and records the verdict', async () => {
    const t = harness({ entries: [entry('e1')], decisions: [decision('e1')] });

    await t.pageEntries.updateEntry('e1', 'person-1', {
      status: PageEntryStatusEnum.STANDING,
    });

    expect(t.entries.get('e1')?.status).toBe('STANDING');
    expect(decided(t, 'e1')).toMatchObject({
      verdict: Verdict.ACCEPTED,
      // The judgments held it back; the person kept it as written.
      agreed: false,
      verdictById: 'person-1',
      verdictAt: expect.any(Date),
    });
    // Resolved: out of the queue.
    expect((await t.review.queue(WORKSPACE)).items).toEqual([]);
  });

  it.each([
    ['setting it aside', PageEntryStatusEnum.ARCHIVED],
    ['disputing it', PageEntryStatusEnum.DISPUTED],
  ])(
    '[KG-5.5] rejecting an escalated entry by %s records the verdict',
    async (_how, status) => {
      const t = harness({
        entries: [entry('e1')],
        decisions: [decision('e1')],
      });

      await t.pageEntries.updateEntry('e1', 'person-1', { status });

      expect(decided(t, 'e1')).toMatchObject({
        verdict: Verdict.REJECTED,
        agreed: true,
        verdictById: 'person-1',
      });
    },
  );

  it('[KG-5.5] editing an escalated entry resolves the escalation as edited', async () => {
    const t = harness({
      entries: [entry('e1'), entry('e2'), entry('e3')],
      decisions: [decision('e1'), decision('e2'), decision('e3')],
    });

    await t.pageEntries.updateEntry('e1', 'person-1', {
      content: 'Webhook deliveries are retried three times.',
    });
    await t.pageEntries.updateEntry('e2', 'person-1', { scope: 'apps/webapp' });
    // Sending what it already says changes nothing, so it is no verdict.
    await t.pageEntries.updateEntry('e3', 'person-1', { content: 'Fact e3.' });

    expect(decided(t, 'e1')).toMatchObject({
      verdict: Verdict.EDITED,
      agreed: true,
    });
    expect(decided(t, 'e2')).toMatchObject({ verdict: Verdict.EDITED });
    expect(decided(t, 'e3')).toMatchObject({ verdict: null });
    // Still waiting to be accepted, but no longer escalated.
    const queue = await t.review.queue(WORKSPACE);
    expect(queue.items.find((item) => item.entry.id === 'e1')).toMatchObject({
      decisionId: null,
      reasons: [],
    });
  });

  it('[KG-5.5] a rule escalation and a shadow decision are resolved the same way', async () => {
    const t = harness({
      entries: [entry('rule'), entry('shadow')],
      decisions: [
        decision('rule', { reasons: [Reason.UNGROUNDED] }),
        decision('shadow', {
          decision: Decision.AUTO_ACCEPT,
          reasons: [],
          mode: 'SHADOW',
        }),
      ],
    });

    await t.pageEntries.updateEntry('rule', 'person-1', {
      status: PageEntryStatusEnum.STANDING,
    });
    await t.pageEntries.updateEntry('shadow', 'person-1', {
      status: PageEntryStatusEnum.STANDING,
    });

    // A rule decided that one: the verdict is kept, and agrees with nothing.
    expect(decided(t, 'rule')).toMatchObject({
      verdict: Verdict.ACCEPTED,
      agreed: null,
    });
    expect(decided(t, 'shadow')).toMatchObject({
      verdict: Verdict.ACCEPTED,
      agreed: true,
    });
  });

  it('[KG-5.5] bulk triage records a verdict for each entry it resolves', async () => {
    const t = harness({
      entries: [entry('e1'), entry('e2'), entry('untriaged')],
      decisions: [
        decision('e1'),
        decision('e2', {
          decision: Decision.REJECT,
          reasons: [],
          policy: Policy.ONE_FACT,
          mode: 'SHADOW',
        }),
      ],
    });

    await expect(
      t.pageEntries.bulkUpdate(WORKSPACE, 'person-1', {
        entryIds: ['e1', 'e2', 'untriaged'],
        status: PageEntryStatusEnum.ARCHIVED,
      }),
    ).resolves.toEqual({ updated: 3, skipped: 0 });

    expect(decided(t, 'e1')).toMatchObject({
      verdict: Verdict.REJECTED,
      agreed: true,
    });
    expect(decided(t, 'e2')).toMatchObject({
      verdict: Verdict.REJECTED,
      agreed: true,
    });
    expect(t.decisions).toHaveLength(2);
  });

  it('[KG-5.5] gives one verdict, the first, and only on the latest decision', async () => {
    const t = harness({
      entries: [entry('e1')],
      decisions: [
        decision('e1', { id: 'older', createdAt: daysAgo(3) }),
        decision('e1'),
      ],
    });

    await t.pageEntries.updateEntry('e1', 'person-1', {
      status: PageEntryStatusEnum.STANDING,
    });
    await t.pageEntries.updateEntry('e1', 'person-2', {
      status: PageEntryStatusEnum.ARCHIVED,
    });

    expect(decided(t, 'e1')).toMatchObject({
      verdict: Verdict.ACCEPTED,
      verdictById: 'person-1',
    });
    expect(t.decisions.find((row) => row.id === 'older')).toMatchObject({
      verdict: null,
    });
  });

  it('[KG-5.5] of two people acting at once, keeps the verdict of the first to land', async () => {
    const t = harness({ entries: [entry('e1')], decisions: [decision('e1')] });
    const waiting = [{ id: 'e1', status: PageEntryStatusEnum.PROPOSED }];

    // Both read the decision as open before either change commits.
    const first = await t.agreement.verdictsFor(
      waiting,
      { status: PageEntryStatusEnum.STANDING, edited: false },
      'person-1',
    );
    const second = await t.agreement.verdictsFor(
      waiting,
      { status: PageEntryStatusEnum.ARCHIVED, edited: false },
      'person-2',
    );
    await t.prisma.$transaction(first.operations);
    await t.prisma.$transaction(second.operations);

    expect(decided(t, 'e1')).toMatchObject({
      verdict: Verdict.ACCEPTED,
      verdictById: 'person-1',
    });
  });

  it('[KG-5.5] asks nothing more of a decision that already has a verdict', async () => {
    const t = harness({
      entries: [entry('e1')],
      decisions: [decision('e1', { verdict: Verdict.EDITED })],
    });

    await expect(
      t.agreement.verdictsFor(
        [{ id: 'e1', status: PageEntryStatusEnum.PROPOSED }],
        { status: PageEntryStatusEnum.STANDING, edited: false },
        'person-1',
      ),
    ).resolves.toEqual({ operations: [], decisionIds: [], workspaceIds: [] });
  });

  it('[KG-5.5] is not given by an agent, by confirming alone, or on what never reached a person', async () => {
    const accepted = entry('accepted', {
      status: PageEntryStatusEnum.STANDING,
    });
    const t = harness({
      entries: [entry('own'), entry('confirmed'), accepted],
      decisions: [
        decision('own'),
        decision('confirmed'),
        // Accepted without a person and not drawn for audit.
        decision('accepted', {
          decision: Decision.AUTO_ACCEPT,
          reasons: [],
          applied: true,
        }),
      ],
    });

    // An agent withdrawing its own entry.
    await t.pageEntries.updateEntry('own', 'agent-1', {
      status: PageEntryStatusEnum.ARCHIVED,
    });
    await t.pageEntries.updateEntry('confirmed', 'person-1', {
      verified: true,
    });
    // Someone happening on it later is not a sample of anything.
    await t.pageEntries.updateEntry('accepted', 'person-1', {
      status: PageEntryStatusEnum.ARCHIVED,
    });

    expect(t.entries.get('own')?.status).toBe('ARCHIVED');
    expect(t.entries.get('accepted')?.status).toBe('ARCHIVED');
    expect(t.decisions.every((row) => row.verdict === null)).toBe(true);
    expect(t.backoff).toEqual([]);
  });

  it('[KG-5.5] a person acting on an audited entry by hand resolves the audit', async () => {
    const { entry: row, decision: audit } = audited(
      'accepted',
      Decision.AUTO_ACCEPT,
    );
    const t = harness({ entries: [row], decisions: [audit] });

    await t.pageEntries.updateEntry('accepted', 'person-1', {
      status: PageEntryStatusEnum.DISPUTED,
    });

    expect(decided(t, 'accepted')).toMatchObject({
      verdict: Verdict.REJECTED,
      agreed: false,
    });
    expect((await t.review.queue(WORKSPACE)).items).toEqual([]);
  });

  it('[KG-5.5] acting by hand on an audited entry that has moved on gives no verdict', async () => {
    const decayed = audited('decayed', Decision.AUTO_ACCEPT);
    decayed.entry.status = PageEntryStatusEnum.ARCHIVED;
    const refused = audited('refused', Decision.REJECT);
    const t = harness({
      entries: [decayed.entry, refused.entry],
      decisions: [decayed.decision, refused.decision],
    });

    await t.pageEntries.updateEntry('decayed', 'person-1', {
      status: PageEntryStatusEnum.STANDING,
    });
    await t.pageEntries.updateEntry('refused', 'person-1', {
      status: PageEntryStatusEnum.STANDING,
    });

    // Decay moved the accepted entry on, so bringing it back judges decay.
    expect(t.entries.get('decayed')?.status).toBe('STANDING');
    expect(decided(t, 'decayed')).toMatchObject({ verdict: null });
    // The refusal still stands as triage left it, so this is a verdict on it.
    expect(decided(t, 'refused')).toMatchObject({
      verdict: Verdict.ACCEPTED,
      agreed: false,
    });
  });

  it('[KG-5.5] [KG-7.4] a person accepting an audited entry folded into its page keeps it; proposing decides nothing', async () => {
    const kept = audited('kept', Decision.AUTO_ACCEPT);
    const byAgent = audited('by-agent', Decision.AUTO_ACCEPT, {
      id: 'decision-by-agent',
    });
    byAgent.entry.pageId = OTHER_PAGE;
    const t = harness({
      entries: [kept.entry, byAgent.entry],
      decisions: [kept.decision, byAgent.decision],
    });

    const byPerson = await t.pagesService.consolidate(PAGE, 'person-1', {
      descriptionMarkdown: 'Fact kept.',
    });
    const fromAgent = await t.pagesService.consolidate(OTHER_PAGE, 'agent-1', {
      descriptionMarkdown: 'Fact by-agent.',
    });

    // A proposal changes nothing, and is no verdict, whoever makes it.
    for (const id of ['kept', 'by-agent']) {
      expect(t.entries.get(id)?.status).toBe('STANDING');
      expect(decided(t, id)).toMatchObject({ verdict: null });
    }

    await t.pagesService.acceptProposal(PAGE, byPerson.id, 'person-1');
    expect(t.entries.get('kept')?.status).toBe('CONSOLIDATED');
    expect(decided(t, 'kept')).toMatchObject({
      verdict: Verdict.ACCEPTED,
      agreed: true,
      verdictById: 'person-1',
    });

    // An agent cannot accept one, its own included; a person can, and the
    // verdict is theirs.
    await expect(
      t.pagesService.acceptProposal(OTHER_PAGE, fromAgent.id, 'agent-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.entries.get('by-agent')?.status).toBe('STANDING');
    expect(decided(t, 'by-agent')).toMatchObject({ verdict: null });

    await t.pagesService.acceptProposal(OTHER_PAGE, fromAgent.id, 'person-2');
    expect(t.entries.get('by-agent')?.status).toBe('CONSOLIDATED');
    expect(decided(t, 'by-agent')).toMatchObject({
      verdict: Verdict.ACCEPTED,
      verdictById: 'person-2',
    });
    // Agreement was measured again after each person's verdict.
    expect(t.prisma.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('[KG-5.5] lands with the change or not at all', async () => {
    const t = harness({ entries: [entry('e1')], decisions: [decision('e1')] });
    (t.prisma.pageEntry.update as jest.Mock).mockImplementationOnce(() =>
      lazy(() => {
        throw new Error('the database went away');
      }),
    );

    await expect(
      t.pageEntries.updateEntry('e1', 'person-1', {
        status: PageEntryStatusEnum.STANDING,
      }),
    ).rejects.toThrow('the database went away');
    expect(decided(t, 'e1')).toMatchObject({ verdict: null });
  });
});

describe('audits', () => {
  it('[KG-5.2] agreeing with an audited acceptance keeps the entry and records the verdict', async () => {
    const { entry: row, decision: audit } = audited('a1', Decision.AUTO_ACCEPT);
    const t = harness({ entries: [row], decisions: [audit] });

    const result = await t.review.resolveAudit(
      WORKSPACE,
      'decision-a1',
      'person-1',
      true,
    );

    expect(result.decision).toMatchObject({
      verdict: Verdict.ACCEPTED,
      agreed: true,
    });
    expect(decided(t, 'a1')).toMatchObject({
      verdict: Verdict.ACCEPTED,
      agreed: true,
      verdictById: 'person-1',
    });
    expect(t.entries.get('a1')?.status).toBe('STANDING');
  });

  it('[KG-5.2] disagreeing with an audited acceptance sets the entry aside', async () => {
    const { entry: row, decision: audit } = audited('a1', Decision.AUTO_ACCEPT);
    const t = harness({ entries: [row], decisions: [audit] });

    await t.review.resolveAudit(WORKSPACE, 'decision-a1', 'person-1', false);

    expect(decided(t, 'a1')).toMatchObject({
      verdict: Verdict.REJECTED,
      agreed: false,
    });
    expect(t.entries.get('a1')?.status).toBe('ARCHIVED');
  });

  it('[KG-5.2] disagreeing with a folded repeat or a refusal puts the entry into use', async () => {
    const repeat = audited('r1', Decision.CORROBORATE, {
      corroboratedEntryId: 'original',
    });
    const refusal = audited('r2', Decision.REJECT, { policy: Policy.ONE_FACT });
    const kept = audited('r3', Decision.CORROBORATE);
    const t = harness({
      entries: [repeat.entry, refusal.entry, kept.entry],
      decisions: [repeat.decision, refusal.decision, kept.decision],
    });

    await t.review.resolveAudit(WORKSPACE, 'decision-r1', 'person-1', false);
    await t.review.resolveAudit(WORKSPACE, 'decision-r2', 'person-1', true);
    await t.review.resolveAudit(WORKSPACE, 'decision-r3', 'person-1', true);

    expect(decided(t, 'r1')).toMatchObject({
      verdict: Verdict.ACCEPTED,
      agreed: false,
    });
    expect(t.entries.get('r1')?.status).toBe('STANDING');
    expect(decided(t, 'r2')).toMatchObject({
      verdict: Verdict.REJECTED,
      agreed: true,
    });
    expect(t.entries.get('r2')?.status).toBe('ARCHIVED');
    expect(decided(t, 'r3')).toMatchObject({
      verdict: Verdict.REJECTED,
      agreed: true,
    });
  });

  it('[KG-5.2] of two answers at once, keeps the first and refuses the second with its change', async () => {
    const { entry: row, decision: audit } = audited(
      'accepted',
      Decision.AUTO_ACCEPT,
    );
    const t = harness({ entries: [row], decisions: [audit] });
    const otherAnswer = () =>
      Object.assign(decided(t, 'accepted'), {
        verdict: Verdict.ACCEPTED,
        agreed: true,
        verdictById: 'person-2',
        verdictAt: new Date(),
      });
    const transaction = t.prisma.$transaction as jest.Mock;
    const run = transaction.getMockImplementation() as (
      work: unknown,
    ) => Promise<unknown>;

    // The other answer commits after this one read the audit as open, but
    // before this one's change commits: the change is rolled back.
    transaction.mockImplementationOnce(async (work: unknown) => {
      otherAnswer();
      return run(work);
    });

    await expect(
      t.review.resolveAudit(WORKSPACE, 'decision-accepted', 'person-1', false),
    ).rejects.toThrow('This audit already has a verdict: accepted.');
    expect(t.entries.get('accepted')?.status).toBe('STANDING');
    expect(decided(t, 'accepted')).toMatchObject({ verdictById: 'person-2' });

    // And one that commits before this one reads it for the verdict: no
    // change is attempted.
    const again = audited('accepted', Decision.AUTO_ACCEPT);
    const u = harness({ entries: [again.entry], decisions: [again.decision] });
    const read = u.prisma.knowledgeTriageDecision.findMany as jest.Mock;
    const find = read.getMockImplementation() as (args: unknown) => unknown;
    read.mockImplementationOnce((args: unknown) => {
      Object.assign(decided(u, 'accepted'), { verdict: Verdict.ACCEPTED });
      return find(args);
    });

    await expect(
      u.review.resolveAudit(WORKSPACE, 'decision-accepted', 'person-1', false),
    ).rejects.toThrow('This audit already has a verdict: accepted.');
    expect(u.entries.get('accepted')?.status).toBe('STANDING');
    expect(u.prisma.pageEntry.update).not.toHaveBeenCalled();
  });

  it('[KG-5.2] disagreeing with a folded repeat takes back the corroboration it counted', async () => {
    const repeat = audited('repeat', Decision.CORROBORATE, {
      corroboratedEntryId: 'original',
    });
    const kept = audited('kept', Decision.CORROBORATE, {
      corroboratedEntryId: 'original',
    });
    const t = harness({
      entries: [
        entry('original', {
          status: PageEntryStatusEnum.STANDING,
          corroborationCount: 2,
        }),
        repeat.entry,
        kept.entry,
      ],
      decisions: [repeat.decision, kept.decision],
    });

    await t.review.resolveAudit(
      WORKSPACE,
      'decision-repeat',
      'person-1',
      false,
    );
    await t.review.resolveAudit(WORKSPACE, 'decision-kept', 'person-1', true);

    expect(t.entries.get('repeat')?.status).toBe('STANDING');
    expect(t.entries.get('original')?.corroborationCount).toBe(1);
  });

  it('[KG-5.2] closes an audit whose entry has moved on since', async () => {
    const decayed = audited('decayed', Decision.AUTO_ACCEPT);
    decayed.entry.status = PageEntryStatusEnum.ARCHIVED;
    const t = harness({
      entries: [decayed.entry],
      decisions: [decayed.decision],
    });

    for (const agree of [true, false]) {
      await expect(
        t.review.resolveAudit(WORKSPACE, 'decision-decayed', 'person-1', agree),
      ).rejects.toThrow('This entry has moved on since triage decided it');
    }
    expect(t.entries.get('decayed')?.status).toBe('ARCHIVED');
    expect(decided(t, 'decayed')).toMatchObject({ verdict: null });
  });

  it('[KG-5.2] answers once, only for an audit, and only in its own workspace', async () => {
    const { entry: row, decision: audit } = audited('a1', Decision.AUTO_ACCEPT);
    const foreign = audited('a2', Decision.AUTO_ACCEPT);
    foreign.entry.pageId = FOREIGN_PAGE;
    foreign.decision.workspaceId = OTHER_WORKSPACE;
    const t = harness({
      entries: [row, entry('e1'), foreign.entry],
      decisions: [audit, decision('e1'), foreign.decision],
    });

    await t.review.resolveAudit(WORKSPACE, 'decision-a1', 'person-1', true);
    await expect(
      t.review.resolveAudit(WORKSPACE, 'decision-a1', 'person-2', false),
    ).rejects.toThrow('already has a verdict');
    expect(decided(t, 'a1')).toMatchObject({ verdictById: 'person-1' });
    expect(t.entries.get('a1')?.status).toBe('STANDING');

    await expect(
      t.review.resolveAudit(WORKSPACE, 'decision-e1', 'person-1', true),
    ).rejects.toThrow('not drawn for audit');
    await expect(
      t.review.resolveAudit(WORKSPACE, 'decision-a2', 'person-1', true),
    ).rejects.toThrow('not found');
    expect(foreign.decision.verdict).toBeNull();
  });

  it('[KG-5.2] takes a verdict from people, never from an agent', async () => {
    const { entry: row, decision: audit } = audited('a1', Decision.AUTO_ACCEPT);
    const t = harness({ entries: [row], decisions: [audit] });

    await expect(
      t.controller.resolveAudit(
        WORKSPACE,
        'agent-1',
        RoleEnum.AGENT,
        'decision-a1',
        { agree: true },
      ),
    ).rejects.toThrow('Review is for people');
    expect(decided(t, 'a1')).toMatchObject({ verdict: null });

    await t.controller.resolveAudit(
      WORKSPACE,
      'person-1',
      RoleEnum.USER,
      'decision-a1',
      { agree: false },
    );
    expect(decided(t, 'a1')).toMatchObject({ verdict: Verdict.REJECTED });
  });
});

describe('agreement', () => {
  function measured() {
    return harness({
      entries: [],
      decisions: [
        ruled('a1', Decision.AUTO_ACCEPT, Verdict.ACCEPTED),
        ruled('a2', Decision.AUTO_ACCEPT, Verdict.ACCEPTED),
        ruled('a3', Decision.AUTO_ACCEPT, Verdict.REJECTED),
        ruled('x1', Decision.ESCALATE, Verdict.REJECTED),
        ruled('x2', Decision.ESCALATE, Verdict.ACCEPTED),
        ruled('c1', Decision.CORROBORATE, Verdict.REJECTED),
        // Outside the window, of another workspace, or not ruled on yet.
        ruled('old', Decision.AUTO_ACCEPT, Verdict.REJECTED, {
          verdictAt: daysAgo(31),
        }),
        ruled('foreign', Decision.AUTO_ACCEPT, Verdict.REJECTED, {
          workspaceId: OTHER_WORKSPACE,
        }),
        decision('open'),
      ],
      backoff: [
        {
          id: 'change-0',
          createdAt: daysAgo(3),
          workspaceId: WORKSPACE,
          decision: Decision.CORROBORATE,
          backedOff: true,
        },
      ],
    });
  }

  it('[KG-5.3] is measured per decision type over the window, with the counts', async () => {
    const t = measured();

    const report = await t.agreement.report(WORKSPACE);
    const [accept, corroborate, reject, escalate] = report.types;

    expect(report).toMatchObject({
      autoTriage: 'on',
      windowDays: 30,
      kappaFloor: 0.6,
      kappaMinSamples: 20,
      auditRate: 0.1,
    });
    expect(report.since.getTime()).toBeCloseTo(daysAgo(30).getTime(), -4);
    // AUTO_ACCEPT over six verdicts, four about acceptance: both 2, triage
    // only 1, person only 1, neither 2. alike 4; chance = 3×3 + 3×3 = 18;
    // (24 - 18) / (36 - 18).
    expect(accept).toMatchObject({
      decision: Decision.AUTO_ACCEPT,
      samples: 4,
      counts: { both: 2, triageOnly: 1, personOnly: 1, neither: 2 },
      backedOff: false,
      changedAt: null,
    });
    expect(accept.kappa).toBeCloseTo(1 / 3, 12);
    // CORROBORATE: the one folded repeat was right. chance = 1×1 + 5×5 =
    // 26; (36 - 26) / (36 - 26) = 1. Backed off since three days ago.
    expect(corroborate).toMatchObject({
      kappa: 1,
      counts: { both: 1, triageOnly: 0, personOnly: 0, neither: 5 },
      backedOff: true,
      changedAt: daysAgo(3),
    });
    // REJECT: nothing refused by anyone, so nothing to go on.
    expect(reject).toMatchObject({ kappa: null, samples: 0, backedOff: false });
    // ESCALATE, reported and never backed off: both 1, triage only 1, person
    // only 1, neither 3. alike 4; chance = 2×2 + 4×4 = 20; (24 - 20) / (36 -
    // 20) = 0.25.
    expect(escalate).toMatchObject({
      decision: Decision.ESCALATE,
      kappa: 0.25,
      samples: 3,
      counts: { both: 1, triageOnly: 1, personOnly: 1, neither: 3 },
      backedOff: false,
      changedAt: null,
    });
  });

  it('[KG-5.3] counts each verdict once, and shows what the audits stand for', async () => {
    const t = harness({
      entries: [],
      decisions: [
        ruled('a1', Decision.AUTO_ACCEPT, Verdict.ACCEPTED, {
          audit: true,
          auditRate: 0.1,
        }),
        ruled('a2', Decision.AUTO_ACCEPT, Verdict.REJECTED, {
          audit: true,
          auditRate: 0.1,
        }),
        ruled('x1', Decision.ESCALATE, Verdict.REJECTED),
        ruled('x2', Decision.ESCALATE, Verdict.REJECTED),
        ruled('x3', Decision.ESCALATE, Verdict.ACCEPTED),
      ],
    });

    const [accept] = (await t.agreement.report(WORKSPACE)).types;

    // Once each: alike 3; chance = 2×2 + 3×3 = 13; (15 - 13) / (25 - 13) =
    // 1/6. The weighted cells say each audit stands for ten.
    expect(accept).toMatchObject({
      samples: 3,
      counts: { both: 1, triageOnly: 1, personOnly: 1, neither: 2 },
      weighted: { both: 10, triageOnly: 10, personOnly: 1, neither: 2 },
    });
    expect(accept.kappa).toBeCloseTo(1 / 6, 12);
  });

  it('[KG-5.3] is served to people through the endpoint, and refused to agents', async () => {
    const t = measured();

    const report = await t.controller.agreementReport(
      WORKSPACE,
      RoleEnum.ADMIN,
    );
    expect(report.types.map((type) => type.decision)).toEqual([
      'AUTO_ACCEPT',
      'CORROBORATE',
      'REJECT',
      'ESCALATE',
    ]);
    expect(report.types[0].samples).toBe(4);

    await expect(
      t.controller.agreementReport(WORKSPACE, RoleEnum.AGENT),
    ).rejects.toThrow('Review is for people');
  });
});

describe('backing off as verdicts arrive', () => {
  const FEW = { knowledge: { autoTriage: 'on', kappaMinSamples: 4 } };
  let logged: jest.SpyInstance;

  beforeEach(() => {
    logged = jest
      .spyOn(LoggerService.prototype, 'info')
      .mockImplementation(() => undefined);
  });

  afterEach(() => logged.mockRestore());

  /** Three verdicts against acceptance, and one escalation still open. */
  function disagreeing(preferences: Row = FEW) {
    return harness({
      preferences,
      entries: [entry('open')],
      decisions: [
        ruled('a1', Decision.AUTO_ACCEPT, Verdict.REJECTED, {
          audit: true,
          auditRate: 1,
        }),
        ruled('a2', Decision.AUTO_ACCEPT, Verdict.REJECTED, {
          audit: true,
          auditRate: 1,
        }),
        ruled('x1', Decision.ESCALATE, Verdict.ACCEPTED),
        decision('open'),
      ],
    });
  }

  it('[KG-5.4] backs a type off once its kappa falls under the floor over enough verdicts, and logs it', async () => {
    const t = disagreeing();

    // The fourth verdict: triage held back what the person kept.
    await t.pageEntries.updateEntry('open', 'person-1', {
      status: PageEntryStatusEnum.STANDING,
    });

    // Triage only 2, person only 2: alike 0; chance = 2×2 + 2×2 = 8;
    // (0 - 8) / (16 - 8) = -1.
    expect(t.backoff).toEqual([
      expect.objectContaining({
        workspaceId: WORKSPACE,
        decision: Decision.AUTO_ACCEPT,
        backedOff: true,
        kappa: -1,
        samples: 4,
        floor: 0.6,
        minSamples: 4,
        windowDays: 30,
      }),
    ]);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          'Triage stopped acting on AUTO_ACCEPT in workspace workspace-1: kappa -1.00 over 4 verdicts',
        ),
        payload: expect.objectContaining({
          decision: Decision.AUTO_ACCEPT,
          backedOff: true,
        }),
      }),
    );
    // One re-evaluation at a time per workspace.
    expect(t.prisma.$executeRaw).toHaveBeenCalledWith(
      expect.anything(),
      'knowledge-backoff:workspace-1',
    );

    // Measured again with nothing new, it changes nothing.
    await expect(t.agreement.reevaluate(WORKSPACE)).resolves.toEqual([]);
    expect(t.backoff).toHaveLength(1);

    // And the next entry triage would accept goes to a person.
    const report = await t.agreement.report(WORKSPACE);
    expect(report.types[0]).toMatchObject({ backedOff: true, samples: 4 });
  });

  it('[KG-5.4] waits for the minimum number of verdicts', async () => {
    const t = disagreeing({ knowledge: { autoTriage: 'on' } });

    await t.pageEntries.updateEntry('open', 'person-1', {
      status: PageEntryStatusEnum.STANDING,
    });

    // Four verdicts at kappa -1, of the twenty needed.
    expect(t.backoff).toEqual([]);
    expect(logged).not.toHaveBeenCalled();
  });

  it('[KG-5.4] resumes on enough agreeing verdicts, and on nothing else', async () => {
    const stopped = {
      id: 'change-0',
      createdAt: daysAgo(40),
      workspaceId: WORKSPACE,
      decision: Decision.AUTO_ACCEPT,
      backedOff: true,
    };
    const heldBack = {
      decision: Decision.ESCALATE,
      reasons: [Reason.LOW_AGREEMENT],
      backedOffFrom: Decision.AUTO_ACCEPT,
      applied: false,
    };
    const seed = (open: string[]) => ({
      preferences: FEW,
      entries: open.map((id) => entry(id)),
      decisions: [
        // What it backed off on has aged out of the window.
        ruled('old1', Decision.AUTO_ACCEPT, Verdict.REJECTED, {
          verdictAt: daysAgo(40),
        }),
        ruled('old2', Decision.AUTO_ACCEPT, Verdict.REJECTED, {
          verdictAt: daysAgo(40),
        }),
        // Since then, what it would have accepted was kept by people.
        ruled('h1', Decision.ESCALATE, Verdict.ACCEPTED, heldBack),
        ruled('h2', Decision.ESCALATE, Verdict.ACCEPTED, heldBack),
        ...open.map((id) => decision(id, heldBack)),
      ],
      backoff: [stopped],
    });

    // Three verdicts in the window, all agreeing: too few to resume on.
    const few = harness(seed(['h3']));
    await few.pageEntries.updateEntry('h3', 'person-1', {
      status: PageEntryStatusEnum.STANDING,
    });
    expect(few.backoff).toEqual([stopped]);

    // Two more kept, and an escalation set aside: both 4, neither 1.
    // chance = 4×4 + 1×1 = 17; (25 - 17) / (25 - 17) = 1.
    const t = harness(seed(['h3', 'h4']));
    await t.pageEntries.updateEntry('h3', 'person-1', {
      status: PageEntryStatusEnum.STANDING,
    });
    expect(t.backoff).toHaveLength(1);
    t.decisions.push(
      ruled('x1', Decision.ESCALATE, Verdict.REJECTED, {
        verdictAt: daysAgo(0.5),
      }),
    );
    await t.pageEntries.bulkUpdate(WORKSPACE, 'person-1', {
      entryIds: ['h4'],
      status: PageEntryStatusEnum.STANDING,
    });

    expect(t.backoff).toEqual([
      stopped,
      expect.objectContaining({
        decision: Decision.AUTO_ACCEPT,
        backedOff: false,
        kappa: 1,
        samples: 4,
      }),
    ]);
    expect(logged).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          'Triage resumed acting on AUTO_ACCEPT in workspace workspace-1: kappa 1.00 over 4 verdicts',
        ),
      }),
    );
  });

  it('[KG-5.4] resumes or backs off a type only on verdicts about that type', async () => {
    const stopped = {
      id: 'change-0',
      createdAt: daysAgo(40),
      workspaceId: WORKSPACE,
      decision: Decision.REJECT,
      backedOff: true,
    };
    const repeat = audited('repeat', Decision.CORROBORATE);
    const shadow = { mode: 'SHADOW', applied: false };
    const t = harness({
      entries: [entry('open'), repeat.entry],
      decisions: [
        // What refusing backed off on has aged out of the window.
        ...['r1', 'r2', 'r3'].map((id) =>
          ruled(id, Decision.REJECT, Verdict.ACCEPTED, {
            policy: 'ONE_FACT',
            verdictAt: daysAgo(40),
          }),
        ),
        // Since then: acceptances people kept, escalations they set aside,
        // and nothing refused.
        ...Array.from({ length: 16 }, (_, index) =>
          ruled(`a${index}`, Decision.AUTO_ACCEPT, Verdict.ACCEPTED, shadow),
        ),
        ...['x1', 'x2', 'x3'].map((id) =>
          ruled(id, Decision.ESCALATE, Verdict.REJECTED),
        ),
        decision('open', {
          ...shadow,
          decision: Decision.AUTO_ACCEPT,
          reasons: [],
        }),
        repeat.decision,
      ],
      backoff: [stopped],
    });

    // Twenty-one verdicts in the window: past the minimum of twenty, but
    // none about refusing and one about folding in.
    await t.pageEntries.updateEntry('open', 'person-1', {
      status: PageEntryStatusEnum.STANDING,
    });
    await t.review.resolveAudit(
      WORKSPACE,
      'decision-repeat',
      'person-1',
      false,
    );

    expect(t.backoff).toEqual([stopped]);
    expect(logged).not.toHaveBeenCalled();

    const report = await t.agreement.report(WORKSPACE);
    expect(
      report.types.map((type) => [type.decision, type.samples, type.backedOff]),
    ).toEqual([
      [Decision.AUTO_ACCEPT, 18, false],
      [Decision.CORROBORATE, 1, false],
      [Decision.REJECT, 0, true],
      [Decision.ESCALATE, 3, false],
    ]);
  });

  it('[KG-5.4] keeps acceptance acting at nineteen agreements in twenty audits', async () => {
    const open = audited('open', Decision.AUTO_ACCEPT);
    const t = harness({
      entries: [open.entry],
      decisions: [
        ...Array.from({ length: 18 }, (_, index) =>
          ruled(`a${index}`, Decision.AUTO_ACCEPT, Verdict.ACCEPTED, {
            audit: true,
            auditRate: 0.1,
          }),
        ),
        ruled('wrong', Decision.AUTO_ACCEPT, Verdict.REJECTED, {
          audit: true,
          auditRate: 0.1,
        }),
        ruled('x1', Decision.ESCALATE, Verdict.REJECTED),
        ruled('x2', Decision.ESCALATE, Verdict.REJECTED),
        open.decision,
      ],
    });

    // The twentieth audit, kept: both 19, triage only 1, neither 2. alike
    // 21; chance = 20×19 + 2×3 = 386; (462 - 386) / (484 - 386) = 76/98.
    await t.review.resolveAudit(WORKSPACE, 'decision-open', 'person-1', true);

    expect(t.backoff).toEqual([]);
    const [accept] = (await t.agreement.report(WORKSPACE)).types;
    expect(accept).toMatchObject({ samples: 20, backedOff: false });
    expect(accept.kappa).toBeCloseTo(76 / 98, 12);
  });

  it('[KG-5.4] never fails the person for a re-evaluation that could not run', async () => {
    const t = disagreeing();
    const failed = jest
      .spyOn(LoggerService.prototype, 'error')
      .mockImplementation(() => undefined);
    (t.prisma.$executeRaw as jest.Mock).mockImplementationOnce(() =>
      lazy(() => {
        throw new Error('lock timeout');
      }),
    );

    await expect(
      t.pageEntries.updateEntry('open', 'person-1', {
        status: PageEntryStatusEnum.STANDING,
      }),
    ).resolves.toMatchObject({ id: 'open', status: 'STANDING' });

    // The verdict stands; the next one re-evaluates.
    expect(decided(t, 'open')).toMatchObject({ verdict: Verdict.ACCEPTED });
    expect(t.backoff).toEqual([]);
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('could not be re-evaluated'),
      }),
    );
    failed.mockRestore();
  });
});

describe("the gardener's proposals", () => {
  function proposal(entryId: string, overrides: Row = {}): Row {
    return {
      id: `proposal-${entryId}`,
      createdAt: daysAgo(1),
      updatedAt: daysAgo(1),
      workspaceId: WORKSPACE,
      entryId,
      action: MaintenanceAction.ARCHIVE_PROPOSED,
      reason: MaintenanceReason.CITATION_MISSING,
      evidence: {
        change: {
          sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
          externalRepoId: 'gh-1',
          repo: 'acme/api',
        },
        citations: [
          {
            citationId: 'c1',
            path: 'src/retry.ts',
            lines: '2-4',
            readSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
            result: 'MISSING',
            judgment: null,
            judgeModel: null,
            judgeReason: null,
          },
        ],
      },
      issueId: null,
      proposalState: ProposalState.OPEN,
      resolvedById: null,
      resolvedAt: null,
      reversedById: null,
      reversedAt: null,
      ...overrides,
    };
  }
  const inUse = (id: string, overrides: Row = {}) =>
    entry(id, {
      status: PageEntryStatusEnum.STANDING,
      sourceUserId: 'person-2',
      ...overrides,
    });
  const proposed = (t: ReturnType<typeof harness>, entryId: string) =>
    t.maintenance.find((row) => row.id === `proposal-${entryId}`) as Row;

  it('[KG-6.2] lists what the gardener asks a person to archive, with what it found, with triage off too', async () => {
    const t = harness({
      entries: [
        entry('waiting'),
        inUse('gone'),
        inUse('moved-on', { status: PageEntryStatusEnum.ARCHIVED }),
        inUse('answered'),
        inUse('foreign', { pageId: FOREIGN_PAGE }),
      ],
      maintenance: [
        proposal('gone'),
        proposal('moved-on'),
        proposal('answered', { proposalState: ProposalState.DECLINED }),
        proposal('foreign', { workspaceId: OTHER_WORKSPACE }),
      ],
      preferences: { knowledge: { autoTriage: 'off' } },
    });

    const queue = await t.review.queue(WORKSPACE);

    expect(queue.items.map((item) => item.entry.id)).toEqual([
      'waiting',
      'gone',
    ]);
    const [, gone] = queue.items;

    expect(gone).toMatchObject({
      reasons: [KnowledgeReviewReasonEnum.CITATION_MISSING],
      decisionId: null,
      audit: false,
      proposal: { id: 'proposal-gone', issueId: null },
    });
    expect(gone.proposal?.summary).toContain('src/retry.ts lines 2-4 is gone');
    expect(gone.proposal?.summary).toContain('a1b2c3d');
    expect(queue.reasons).toEqual([
      { reason: KnowledgeReviewReasonEnum.CITATION_MISSING, count: 1 },
    ]);
  });

  it('[KG-6.2] archiving on a proposal takes the entry out of use and resolves it; a second answer is refused', async () => {
    const t = harness({
      entries: [inUse('gone')],
      maintenance: [proposal('gone')],
    });

    await expect(
      t.controller.resolveProposal(
        WORKSPACE,
        'person-1',
        RoleEnum.USER,
        'proposal-gone',
        { accept: true },
      ),
    ).resolves.toEqual({ proposalId: 'proposal-gone', accepted: true });

    expect(t.entries.get('gone')?.status).toBe(PageEntryStatusEnum.ARCHIVED);
    expect(proposed(t, 'gone')).toMatchObject({
      proposalState: ProposalState.ACCEPTED,
      resolvedById: 'person-1',
    });
    await expect(
      t.review.resolveProposal(WORKSPACE, 'proposal-gone', 'person-2', false),
    ).rejects.toThrow('already answered: accepted');
  });

  it('[KG-6.2] of two answers at once, keeps the first and rolls back the second with its change', async () => {
    const t = harness({
      entries: [inUse('gone')],
      maintenance: [proposal('gone')],
    });
    const transaction = t.prisma.$transaction as jest.Mock;
    const run = transaction.getMockImplementation() as (
      work: unknown,
    ) => Promise<unknown>;

    transaction.mockImplementationOnce(async (work: unknown) => {
      Object.assign(proposed(t, 'gone'), {
        proposalState: ProposalState.DECLINED,
        resolvedById: 'person-2',
      });
      return run(work);
    });

    await expect(
      t.review.resolveProposal(WORKSPACE, 'proposal-gone', 'person-1', true),
    ).rejects.toThrow('answered by someone else first');
    expect(t.entries.get('gone')?.status).toBe(PageEntryStatusEnum.STANDING);
    expect(proposed(t, 'gone')).toMatchObject({ resolvedById: 'person-2' });
  });

  it('[KG-6.2] keeping the entry declines the proposal and leaves it in use', async () => {
    const t = harness({
      entries: [inUse('gone')],
      maintenance: [proposal('gone')],
    });

    await t.review.resolveProposal(
      WORKSPACE,
      'proposal-gone',
      'person-1',
      false,
    );

    expect(t.entries.get('gone')?.status).toBe(PageEntryStatusEnum.STANDING);
    expect(proposed(t, 'gone')).toMatchObject({
      proposalState: ProposalState.DECLINED,
      resolvedById: 'person-1',
    });
    expect((await t.review.queue(WORKSPACE)).items).toEqual([]);
  });

  it('[KG-6.2] cannot be answered once its entry has moved on, by an agent, or from another workspace', async () => {
    const t = harness({
      entries: [
        inUse('moved-on', { status: PageEntryStatusEnum.DISPUTED }),
        inUse('gone'),
        inUse('foreign', { pageId: FOREIGN_PAGE }),
      ],
      maintenance: [
        proposal('moved-on'),
        proposal('gone'),
        proposal('foreign', { workspaceId: OTHER_WORKSPACE }),
      ],
    });

    await expect(
      t.review.resolveProposal(
        WORKSPACE,
        'proposal-moved-on',
        'person-1',
        true,
      ),
    ).rejects.toThrow('has moved on');
    await expect(
      t.controller.resolveProposal(
        WORKSPACE,
        'agent-1',
        RoleEnum.AGENT,
        'proposal-gone',
        { accept: true },
      ),
    ).rejects.toThrow('Review is for people');
    await expect(
      t.review.resolveProposal(WORKSPACE, 'proposal-foreign', 'person-1', true),
    ).rejects.toThrow('not found');
    expect(proposed(t, 'gone').proposalState).toBe(ProposalState.OPEN);
    expect(t.entries.get('moved-on')?.status).toBe(
      PageEntryStatusEnum.DISPUTED,
    );
  });

  it('[KG-6.2] [KG-6.3] a person putting back an entry the gardener took out of use records the undo', async () => {
    const undone = (id: string, action: MaintenanceAction): Row => ({
      ...proposal(id),
      id: `done-${id}`,
      action,
      reason:
        action === MaintenanceAction.DISPUTED
          ? MaintenanceReason.CITATION_CONTRADICTED
          : MaintenanceReason.HARMFUL_SIGNALS,
      proposalState: null,
    });
    const t = harness({
      entries: [
        inUse('disputed', { status: PageEntryStatusEnum.DISPUTED }),
        inUse('archived', { status: PageEntryStatusEnum.ARCHIVED }),
        inUse('kept-out', { status: PageEntryStatusEnum.DISPUTED }),
      ],
      maintenance: [
        undone('disputed', MaintenanceAction.DISPUTED),
        undone('archived', MaintenanceAction.ARCHIVED),
        undone('kept-out', MaintenanceAction.DISPUTED),
      ],
    });
    const done = (id: string) =>
      t.maintenance.find((row) => row.id === `done-${id}`) as Row;

    await t.pageEntries.updateEntry('disputed', 'person-1', {
      status: PageEntryStatusEnum.STANDING,
    });
    await t.pageEntries.bulkUpdate(WORKSPACE, 'person-2', {
      entryIds: ['archived'],
      status: PageEntryStatusEnum.STANDING,
    });
    // Agreeing that it is wrong is not an undo.
    await t.pageEntries.updateEntry('kept-out', 'person-1', {
      status: PageEntryStatusEnum.ARCHIVED,
    });

    expect(done('disputed')).toMatchObject({ reversedById: 'person-1' });
    expect(done('disputed').reversedAt).toBeInstanceOf(Date);
    expect(done('archived')).toMatchObject({ reversedById: 'person-2' });
    expect(done('kept-out')).toMatchObject({ reversedAt: null });
  });
});

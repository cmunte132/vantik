import type { ConnectorPeer } from './connector.registry';
import type { ConnectorAck, ConnectorSessionActivity } from '@vantikhq/types';

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import {
  type SessionStep,
  type SessionUsageCall,
  entryTime,
  parseSessionEntries,
} from 'modules/agent-runs/executors/session-entries';

import {
  billingKey,
  type LinkedIssue,
  issueAt,
  transitionOf,
  type Transition,
} from './session-attribution';
import { ownedSessions, UUID } from './session-drivers.service';

/** The most entries one message may carry. The connector sends 200. */
const MAX_ENTRIES = 500;
/** The most terminal steps kept for one run or session; the oldest go first. */
const MAX_TERMINAL_EVENTS = 2000;
/** The longest child session id the server keeps. */
const SOURCE_ID_MAX = 200;
/** The key of the root session's own record in `AgentTranscript.sources`. */
const MAIN = 'main';
const TRANSCRIPT_HARNESS = 'omp';

/** The phase and source that mark a step as the person's own terminal work. */
export const TERMINAL_PHASE = 'terminal';

type Tx = Prisma.TransactionClient;
type Entry = Record<string, unknown>;

/** One of the person's sessions for the watched root: one row per issue it works on. */
interface LinkedRow {
  id: string;
  issueId: string;
  createdAt: Date;
  agentRunId: string | null;
  terminalSeenAt: Date | null;
  terminalCostUsd: number;
  terminalTurns: number;
  terminalUnknownCalls: number;
  issue: { number: number; team: { identifier: string } };
  agentRun: { finishedAt: Date | null } | null;
}

/** The totals an issue had before the record existed. They are not verified. */
interface Baseline {
  costUsd: number;
  turns: number;
  unknownCalls: number;
}

/** What the canonical record keeps for one source: the root file, or one child file. */
interface SourceState {
  /** A child's issue, fixed when the child started. The root has none. */
  issueId?: string | null;
  /** When the child started, or its first entry when the header has no time. */
  startedAt?: string;
  /** The newest entry this source has recorded. */
  lastAt?: string;
  calls: number;
  unknownCalls: number;
  /** Whether totals existed before the record did. Set on the root only. */
  legacyTotals?: boolean;
  /** Per issue, the totals that existed before the record. Set on the root only. */
  legacyBaseline?: Record<string, Baseline>;
}

interface BillingBucket {
  costUsd: number;
  pricedCalls: number;
  unpricedCalls: number;
}

/** What one issue receives from a batch. */
interface Share {
  costUsd: number;
  turns: number;
  unknownCalls: number;
}

interface TranscriptRow {
  id: string;
  startedAt: Date | null;
  lastAt: Date | null;
  billingSummary: unknown;
  sources: unknown;
}

interface Batch {
  transcript: TranscriptRow;
  rows: LinkedRow[];
  source: string | null;
  startedAt: Date | null;
  entries: unknown[];
}

/**
 * What a person does in their own terminal, in an omp session that Vantik
 * knows about.
 *
 * The connector reads the omp session file and sends the new entries. Two
 * things come from them.
 *
 * The steps: a step of the root session is written to the issue it was done
 * for, and only to that issue's row. A session with a run writes them to the
 * run's events. Each step has a key from its native entry, so a replay adds
 * none.
 *
 * The accounting: each model call and each external Claude result is claimed
 * once in the person's `AgentTranscript` for the root session, under a stable
 * id. The claim is what makes a replay, or a retry after a lost
 * acknowledgement, add nothing. A call belongs to the issue that was current
 * when it was written, and each issue row receives only its own share.
 */
@Injectable()
export class SessionActivityService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records a batch of entries from the root session, or from one of its child
   * sessions. A batch that arrives twice is not recorded twice.
   */
  async apply(peer: ConnectorPeer, body: unknown): Promise<ConnectorAck> {
    const { externalId, entries, sourceSessionId, sourceStartedAt } = (body ??
      {}) as Partial<ConnectorSessionActivity>;

    if (typeof externalId !== 'string' || !UUID.test(externalId)) {
      return { ok: false, reason: 'Send the omp session uuid.' };
    }

    if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) {
      return {
        ok: false,
        reason: `Send at most ${MAX_ENTRIES} entries as a list.`,
      };
    }

    const source =
      sourceSessionId === undefined ? null : normalizeSourceId(sourceSessionId);
    if (sourceSessionId !== undefined && source === null) {
      return { ok: false, reason: 'Send a child session id, without a path.' };
    }
    const startedAt =
      sourceStartedAt === undefined ? null : parseTime(sourceStartedAt);
    if (sourceStartedAt !== undefined && startedAt === null) {
      return { ok: false, reason: 'Send the child session start as a time.' };
    }

    // Not the person's session, or one that Vantik does not know: nothing to
    // record, and nothing the connector can fix by sending it again.
    const outer = await this.linkedRows(this.prisma, peer, externalId);
    if (outer.length === 0) {
      return { ok: true };
    }

    // Totals from before the record existed are kept as a baseline, unverified.
    const baseline = legacyBaselineOf(outer);

    return this.prisma.$transaction(async (tx): Promise<ConnectorAck> => {
      const transcript = await this.lockTranscript(
        tx,
        peer,
        externalId,
        baseline,
      );
      const rows = await this.linkedRows(tx, peer, externalId);
      if (rows.length === 0) {
        return { ok: true };
      }
      return this.ingest(tx, {
        transcript,
        rows,
        source,
        startedAt,
        entries,
      });
    });
  }

  private linkedRows(
    db: Tx,
    peer: ConnectorPeer,
    externalId: string,
  ): Promise<LinkedRow[]> {
    return db.agentSession.findMany({
      where: {
        ...ownedSessions(peer),
        // The hooks write `omp:<uuid>`; the connector writes the bare uuid.
        externalId: { in: [externalId, `omp:${externalId}`] },
      },
      select: {
        id: true,
        issueId: true,
        createdAt: true,
        agentRunId: true,
        terminalSeenAt: true,
        terminalCostUsd: true,
        terminalTurns: true,
        terminalUnknownCalls: true,
        issue: {
          select: { number: true, team: { select: { identifier: true } } },
        },
        agentRun: { select: { finishedAt: true } },
      },
    });
  }

  /**
   * The person's record for the root session, locked for the rest of the
   * transaction. Two batches of one session run one after the other, so the
   * second reads the totals that the first wrote.
   */
  private async lockTranscript(
    tx: Tx,
    peer: ConnectorPeer,
    externalId: string,
    baseline: Record<string, Baseline> | null,
  ): Promise<TranscriptRow> {
    const key = {
      workspaceId: peer.workspaceId,
      actorUserId: peer.userId,
      harness: TRANSCRIPT_HARNESS,
      externalId,
    };
    const initial: SourceState | null = baseline
      ? {
          calls: 0,
          unknownCalls: 0,
          legacyTotals: true,
          legacyBaseline: baseline,
        }
      : null;
    await tx.agentTranscript.createMany({
      data: [
        {
          ...key,
          sources: initial ? { [MAIN]: initial } : {},
        } as unknown as Prisma.AgentTranscriptCreateManyInput,
      ],
      skipDuplicates: true,
    });
    const { id } = await tx.agentTranscript.findUniqueOrThrow({
      where: { workspaceId_actorUserId_harness_externalId: key },
      select: { id: true },
    });
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "AgentTranscript" WHERE "id" = ${id} FOR UPDATE`,
    );
    return tx.agentTranscript.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        startedAt: true,
        lastAt: true,
        billingSummary: true,
        sources: true,
      },
    });
  }

  private async ingest(tx: Tx, batch: Batch): Promise<ConnectorAck> {
    const { transcript, rows, source, entries } = batch;
    const runs = rows.filter((row) => row.agentRunId);
    // A run's own work is the run's. Only what came after it finished is the
    // terminal's, and the terminal waits for a run that has not finished.
    const boundary = latest(
      runs.map((row) => row.agentRun?.finishedAt ?? null),
    );
    const running = runs.some((row) => !row.agentRun?.finishedAt);

    const sources = {
      ...((transcript.sources ?? {}) as Record<string, SourceState>),
    };
    const key = source ? `child:${source}` : MAIN;

    // Only entries after the run finished are the terminal's.
    let fresh = entries.filter((entry) => {
      if (!boundary) {
        return true;
      }
      const at = timeOf(entry);
      return at !== null && at > boundary;
    });
    // omp writes its last entries while it shuts down, a few milliseconds
    // after the run is marked finished. Terminal work starts with a prompt the
    // person sends, so until one has been recorded, skip to it.
    if (!source && boundary) {
      const lastAt = parseDate(sources[MAIN]?.lastAt);
      if (!lastAt || lastAt < boundary) {
        const start = fresh.findIndex(isUserPrompt);
        fresh = start === -1 ? [] : fresh.slice(start);
      }
    }

    const parsed = parseSessionEntries(fresh);
    const links = linkedIssues(rows);
    const transitions = await this.transitionsOf(tx, transcript.id, links);
    const prefix = source ? `child:${source}:` : 'main:';

    // Claims that already exist are not counted again.
    const candidates = [
      ...parsed.calls.map((call) => prefix + call.id),
      ...(source ? [] : parsed.tasks.map((task) => `main:${task.key}`)),
    ];
    const existing = new Set<string>(
      candidates.length === 0
        ? []
        : (
            await tx.agentTranscriptCall.findMany({
              where: {
                transcriptId: transcript.id,
                callId: { in: candidates },
              },
              select: { callId: true },
            })
          ).map((row) => row.callId),
    );
    const calls = parsed.calls.filter(
      (call) => !existing.has(prefix + call.id),
    );
    const tasks = source
      ? []
      : parsed.tasks.filter((task) => !existing.has(`main:${task.key}`));

    // A pickup or write moves the work from the call after it; a read never does.
    // The steps of this batch are attributed with the pickups it holds too.
    const timeline: Transition[] = [
      ...transitions,
      ...tasks.flatMap(
        (task): Transition | Transition[] =>
          transitionOf(task.at, task.tool, task.taskRef, links) ?? [],
      ),
    ];

    if (!source) {
      await this.recordSteps(tx, rows, entries, timeline, links);
    }
    if (running) {
      return { ok: true };
    }

    // A child belongs to the issue its root was on when the child started, as
    // the recorded transitions show. The root need not have reported since: an
    // idle parent waiting for its child has no later entry, so nothing is held.
    if (source && !sources[key]) {
      if (fresh.length === 0) {
        return { ok: true };
      }
      const bindAt = batch.startedAt ?? earliestTime(fresh);
      if (!bindAt) {
        return { ok: true };
      }
      sources[key] = {
        issueId: issueAt(bindAt, transitions, links),
        startedAt: bindAt.toISOString(),
        calls: 0,
        unknownCalls: 0,
      };
    }

    const attributed = calls.map((call) => ({
      call,
      issueId: source
        ? (sources[key]?.issueId ?? null)
        : issueAt(call.at ?? new Date(0), timeline, links),
    }));

    const claims: Prisma.AgentTranscriptCallCreateManyInput[] = [
      ...tasks.map((task): Prisma.AgentTranscriptCallCreateManyInput => ({
        transcriptId: transcript.id,
        kind: 'task',
        callId: `main:${task.key}`,
        sourceSessionId: null,
        at: task.at,
        issueId: null,
        costUsd: null,
        billingMode: 'none',
        costBasis: 'none',
        data: {
          tool: task.tool,
          taskRef: task.taskRef,
        } as Prisma.InputJsonValue,
      })),
      ...attributed.map(
        ({ call, issueId }): Prisma.AgentTranscriptCallCreateManyInput => ({
          transcriptId: transcript.id,
          kind: 'call',
          callId: prefix + call.id,
          sourceSessionId: source,
          at: call.at,
          issueId,
          costUsd: call.costUsd,
          billingMode: call.billingMode,
          costBasis: call.costBasis,
          data: callData(call),
        }),
      ),
    ];
    await tx.agentTranscriptCall.createMany({
      data: claims,
      skipDuplicates: true,
    });

    let known = 0;
    let unattributed = 0;
    let unknown = 0;
    const billing = {
      ...((transcript.billingSummary ?? {}) as Record<string, BillingBucket>),
    };
    const shares = new Map<string, Share>();
    for (const { call, issueId } of attributed) {
      const cost = call.costUsd;
      const bucketKey = billingKey(call.billingMode, call.costBasis);
      const bucket = billing[bucketKey] ?? {
        costUsd: 0,
        pricedCalls: 0,
        unpricedCalls: 0,
      };
      if (cost === null) {
        unknown += 1;
        bucket.unpricedCalls += 1;
      } else {
        known += cost;
        bucket.costUsd += cost;
        bucket.pricedCalls += 1;
        if (!issueId) {
          unattributed += cost;
        }
      }
      billing[bucketKey] = bucket;

      if (issueId) {
        const share = shares.get(issueId) ?? {
          costUsd: 0,
          turns: 0,
          unknownCalls: 0,
        };
        share.costUsd += cost ?? 0;
        share.turns += call.purpose === 'assistant' ? 1 : 0;
        share.unknownCalls += cost === null ? 1 : 0;
        shares.set(issueId, share);
      }
    }

    const observed = latestTime(fresh);
    const current = sources[key] ?? { calls: 0, unknownCalls: 0 };
    sources[key] = {
      ...current,
      calls: current.calls + attributed.length,
      unknownCalls: current.unknownCalls + unknown,
      lastAt: iso(later(parseDate(current.lastAt), observed)),
    };

    await tx.agentTranscript.update({
      where: { id: transcript.id },
      data: {
        knownCostUsd: { increment: known },
        unattributedCostUsd: { increment: unattributed },
        unknownCallCount: { increment: unknown },
        billingSummary: billing as unknown as Prisma.InputJsonValue,
        sources: sources as unknown as Prisma.InputJsonValue,
        lastAt: later(transcript.lastAt, observed),
        startedAt: transcript.startedAt ?? earliestTime(fresh),
      },
    });

    for (const [issueId, share] of shares) {
      const row = primaryRow(rows, issueId);
      if (!row) {
        continue;
      }
      await tx.agentSession.update({
        where: { id: row.id },
        data: {
          terminalCostUsd: { increment: share.costUsd },
          terminalTurns: { increment: share.turns },
          terminalUnknownCalls: { increment: share.unknownCalls },
        },
      });
      if (row.agentRunId && (share.costUsd || share.turns)) {
        await this.addToRun(tx, row.agentRunId, share);
      }
    }

    return { ok: true };
  }

  /** The pickups and writes already recorded, resolved against the current links. */
  private async transitionsOf(
    tx: Tx,
    transcriptId: string,
    links: LinkedIssue[],
  ): Promise<Transition[]> {
    const rows = await tx.agentTranscriptCall.findMany({
      where: { transcriptId, kind: 'task' },
      select: { at: true, data: true },
    });
    return rows.flatMap((row) => {
      if (!row.at) {
        return [];
      }
      const data = (row.data ?? {}) as Entry;
      const transition = transitionOf(
        row.at,
        data.tool === 'write' ? 'write' : 'pickup',
        typeof data.taskRef === 'string' ? data.taskRef : '',
        links,
      );
      return transition ? [transition] : [];
    });
  }

  /**
   * Writes each linked row's steps: the steps done for that row's issue, by the
   * timeline, and nothing else. A row whose run has not finished takes none.
   * A step is keyed by its native entry, so the same step is one row.
   */
  private async recordSteps(
    tx: Tx,
    rows: LinkedRow[],
    entries: unknown[],
    timeline: Transition[],
    links: LinkedIssue[],
  ): Promise<void> {
    for (const row of rows) {
      // A run reports its own work while it runs, so only what came after it
      // finished is the terminal's. A run that has not finished records nothing.
      const finishedAt = row.agentRun?.finishedAt ?? null;
      if (row.agentRunId && !finishedAt) {
        continue;
      }
      let mine = entries.filter((entry) => {
        if (!finishedAt) {
          return true;
        }
        const at = timeOf(entry);
        return at !== null && at > finishedAt;
      });
      // omp writes its last entries while it shuts down, a few milliseconds
      // after the run is marked finished. Terminal work starts with a prompt
      // the person sends, so until one has been recorded, skip to it.
      if (finishedAt && !row.terminalSeenAt) {
        const start = mine.findIndex(isUserPrompt);
        mine = start === -1 ? [] : mine.slice(start);
      }
      const parsed = parseSessionEntries(mine);

      if (!parsed.lastAt) {
        continue;
      }

      const data = parsed.steps
        .filter((step) => issueAt(step.at, timeline, links) === row.issueId)
        .map((step) => toRow(step));
      if (data.length > 0) {
        if (row.agentRunId) {
          await tx.agentRunEvent.createMany({
            data: data.map((item) => ({ ...item, runId: row.agentRunId! })),
            skipDuplicates: true,
          });
        } else {
          await tx.agentSessionEvent.createMany({
            data: data.map((item) => ({ ...item, sessionId: row.id })),
            skipDuplicates: true,
          });
        }
        await this.trim(
          tx,
          row.agentRunId ? 'run' : 'session',
          row.agentRunId ?? row.id,
        );
      }

      await tx.agentSession.update({
        where: { id: row.id },
        data: { terminalSeenAt: parsed.lastAt },
      });
      // Never backwards: the driver check also moves this time forward.
      await tx.agentSession.updateMany({
        where: { id: row.id, lastActiveAt: { lt: parsed.lastAt } },
        data: { lastActiveAt: parsed.lastAt },
      });
    }
  }

  /** Adds an issue's attributed turns and cost to what the run's own page shows. */
  private async addToRun(tx: Tx, runId: string, share: Share): Promise<void> {
    const run = await tx.agentRun.findUnique({
      where: { id: runId },
      select: { result: true },
    });
    const result = (run?.result ?? {}) as Record<string, unknown>;
    const number = (value: unknown) => (typeof value === 'number' ? value : 0);

    await tx.agentRun.update({
      where: { id: runId },
      data: {
        result: {
          ...result,
          costUsd: number(result.costUsd) + share.costUsd,
          turns: number(result.turns) + share.turns,
        } as Prisma.InputJsonValue,
      },
    });
  }

  /** Drops the oldest terminal steps past the cap. */
  private async trim(
    tx: Tx,
    kind: 'run' | 'session',
    id: string,
  ): Promise<void> {
    if (kind === 'run') {
      const old = await tx.agentRunEvent.findMany({
        where: { runId: id, phase: TERMINAL_PHASE },
        orderBy: { at: 'desc' },
        skip: MAX_TERMINAL_EVENTS,
        select: { id: true },
      });
      if (old.length > 0) {
        await tx.agentRunEvent.deleteMany({
          where: { id: { in: old.map((row) => row.id) } },
        });
      }
      return;
    }

    const old = await tx.agentSessionEvent.findMany({
      where: { sessionId: id },
      orderBy: { at: 'desc' },
      skip: MAX_TERMINAL_EVENTS,
      select: { id: true },
    });
    if (old.length > 0) {
      await tx.agentSessionEvent.deleteMany({
        where: { id: { in: old.map((row) => row.id) } },
      });
    }
  }
}

/**
 * A child's native id: its header id, or a root-relative file identity. Never an
 * absolute path, a parent reference or a Windows path.
 */
function normalizeSourceId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const id = value.trim();
  if (
    !id ||
    id.length > SOURCE_ID_MAX ||
    id.includes('\\') ||
    id.startsWith('/') ||
    /^[a-zA-Z]:/.test(id) ||
    id.split('/').includes('..')
  ) {
    return null;
  }
  return id;
}

/**
 * The totals per issue that the root's rows held before the record existed.
 * Null when there were none, so a new record starts clean.
 */
function legacyBaselineOf(rows: LinkedRow[]): Record<string, Baseline> | null {
  const legacy = rows.some(
    (row) =>
      row.terminalSeenAt !== null ||
      row.terminalCostUsd > 0 ||
      row.terminalTurns > 0 ||
      row.terminalUnknownCalls > 0,
  );
  if (!legacy) {
    return null;
  }
  const baseline: Record<string, Baseline> = {};
  for (const row of rows) {
    const current = baseline[row.issueId] ?? {
      costUsd: 0,
      turns: 0,
      unknownCalls: 0,
    };
    current.costUsd += row.terminalCostUsd;
    current.turns += row.terminalTurns;
    current.unknownCalls += row.terminalUnknownCalls;
    baseline[row.issueId] = current;
  }
  return baseline;
}

function timeOf(entry: unknown): Date | null {
  return typeof entry === 'object' && entry !== null
    ? entryTime(entry as Entry)
    : null;
}

/** A message the person typed, as opposed to a tool result or a reply. */
function isUserPrompt(entry: unknown): boolean {
  const value = entry as { type?: unknown; message?: { role?: unknown } };
  return value?.type === 'message' && value.message?.role === 'user';
}

function latest(values: Array<Date | null | undefined>): Date | null {
  let newest: Date | null = null;
  for (const value of values) {
    if (value && (!newest || value > newest)) {
      newest = value;
    }
  }
  return newest;
}

function later(
  a: Date | null | undefined,
  b: Date | null | undefined,
): Date | null {
  return latest([a, b]);
}

function latestTime(entries: unknown[]): Date | null {
  return latest(entries.map(timeOf));
}

function earliestTime(entries: unknown[]): Date | null {
  let first: Date | null = null;
  for (const entry of entries) {
    const at = timeOf(entry);
    if (at && (!first || at < first)) {
      first = at;
    }
  }
  return first;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseTime(value: unknown): Date | null {
  return typeof value === 'string' ? parseDate(value) : null;
}

function iso(value: Date | null): string | undefined {
  return value ? value.toISOString() : undefined;
}

/** The linked issues of the root, once each, with the time it was first linked. */
function linkedIssues(rows: LinkedRow[]): LinkedIssue[] {
  const byId = new Map<string, LinkedIssue>();
  for (const row of rows) {
    const current = byId.get(row.issueId);
    if (!current || row.createdAt < current.createdAt) {
      byId.set(row.issueId, {
        id: row.issueId,
        // The human key, as the agent names it: the team's identifier and the
        // issue's number, such as ENG-42.
        key: `${row.issue.team.identifier}-${row.issue.number}`,
        createdAt: row.createdAt,
      });
    }
  }
  return [...byId.values()];
}

/** The row that carries an issue's share: the run's row when there is one. */
function primaryRow(rows: LinkedRow[], issueId: string): LinkedRow | undefined {
  const matching = rows.filter((row) => row.issueId === issueId);
  return matching.find((row) => row.agentRunId) ?? matching[0];
}

/** The provenance of a call, as the record keeps it. */
function callData(call: SessionUsageCall): Prisma.InputJsonValue {
  return {
    purpose: call.purpose,
    modelId: call.modelId,
    ...(call.inputTokens !== undefined
      ? { inputTokens: call.inputTokens }
      : {}),
    ...(call.outputTokens !== undefined
      ? { outputTokens: call.outputTokens }
      : {}),
    ...(call.cacheReadTokens !== undefined
      ? { cacheReadTokens: call.cacheReadTokens }
      : {}),
    ...(call.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: call.cacheWriteTokens }
      : {}),
    ...call.provenance,
  } as Prisma.InputJsonValue;
}

function toRow(step: SessionStep) {
  return {
    at: step.at,
    level: step.level,
    message: step.message,
    phase: TERMINAL_PHASE,
    sourceKey: step.key,
    data: {
      ...(step.data ?? {}),
      source: 'terminal',
    } as Prisma.InputJsonValue,
  };
}

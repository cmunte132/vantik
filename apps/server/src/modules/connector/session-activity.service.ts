import type { ConnectorPeer } from './connector.registry';
import type { ConnectorAck, ConnectorSessionActivity } from '@vantikhq/types';

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import {
  type SessionStep,
  parseSessionEntries,
} from 'modules/agent-runs/executors/session-entries';

import { ownedSessions, UUID } from './session-drivers.service';

/** The most entries one message may carry. The connector sends 200. */
const MAX_ENTRIES = 500;
/** The most terminal steps kept for one run or session; the oldest go first. */
const MAX_TERMINAL_EVENTS = 2000;

/** The phase and source that mark a step as the person's own terminal work. */
export const TERMINAL_PHASE = 'terminal';

/**
 * What a person does in their own terminal, in an omp session that Vantik
 * knows about.
 *
 * The connector reads the omp session file and sends the new entries. They
 * become the steps that a run would have, marked with the phase `terminal` and
 * `data.source: 'terminal'`. A session with a run writes them to the run's
 * events, so the run page shows them as one more segment and the run's totals
 * include them. A session without a run keeps them in its own events.
 */
@Injectable()
export class SessionActivityService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records a batch of entries for the person's own session. Entries older than
   * the newest one already recorded are dropped, so a batch that arrives twice
   * (the connector lost the acknowledgement) is not stored twice.
   */
  async apply(peer: ConnectorPeer, body: unknown): Promise<ConnectorAck> {
    const { externalId, entries } = (body ??
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

    const sessions = await this.prisma.agentSession.findMany({
      where: {
        ...ownedSessions(peer),
        externalId: { in: [externalId, `omp:${externalId}`] },
      },
      select: {
        id: true,
        agentRunId: true,
        terminalSeenAt: true,
        agentRun: { select: { finishedAt: true } },
      },
    });

    // Not the person's session, or one that Vantik does not know: nothing to
    // record, and nothing the connector can fix by sending it again.
    for (const session of sessions) {
      // A run reports its own work while it runs, so only what came after it
      // finished is the terminal's. A run that has not finished records nothing.
      const finishedAt = session.agentRun?.finishedAt ?? null;
      if (session.agentRunId && !finishedAt) {
        continue;
      }
      const fresh = entries.filter((entry) => {
        const at = entryAt(entry);
        if (finishedAt && (!at || at <= finishedAt)) {
          return false;
        }
        return !session.terminalSeenAt || !at || at >= session.terminalSeenAt;
      });
      const parsed = parseSessionEntries(fresh);

      if (!parsed.lastAt) {
        continue;
      }

      await this.record(session, parsed);
    }

    return { ok: true };
  }

  private async record(
    session: { id: string; agentRunId: string | null },
    parsed: ReturnType<typeof parseSessionEntries>,
  ): Promise<void> {
    const rows = parsed.steps.map((step) => toRow(step));

    if (session.agentRunId) {
      await this.prisma.agentRunEvent.createMany({
        data: rows.map((row) => ({ ...row, runId: session.agentRunId! })),
      });
      await this.trim('run', session.agentRunId);
      await this.addToRun(session.agentRunId, parsed);
    } else {
      await this.prisma.agentSessionEvent.createMany({
        data: rows.map((row) => ({ ...row, sessionId: session.id })),
      });
      await this.trim('session', session.id);
    }

    await this.prisma.agentSession.update({
      where: { id: session.id },
      data: {
        terminalTurns: { increment: parsed.turns },
        terminalCostUsd: { increment: parsed.costUsd },
        terminalSeenAt: parsed.lastAt,
      },
    });
    // Never backwards: the driver check also moves this time forward.
    await this.prisma.agentSession.updateMany({
      where: { id: session.id, lastActiveAt: { lt: parsed.lastAt! } },
      data: { lastActiveAt: parsed.lastAt! },
    });
  }

  /** Adds the terminal turns and cost to what the run's own page shows. */
  private async addToRun(
    runId: string,
    parsed: ReturnType<typeof parseSessionEntries>,
  ): Promise<void> {
    const run = await this.prisma.agentRun.findUnique({
      where: { id: runId },
      select: { result: true },
    });
    const result = (run?.result ?? {}) as Record<string, unknown>;
    const number = (value: unknown) => (typeof value === 'number' ? value : 0);

    await this.prisma.agentRun.update({
      where: { id: runId },
      data: {
        result: {
          ...result,
          costUsd: number(result.costUsd) + parsed.costUsd,
          turns: number(result.turns) + parsed.turns,
        } as Prisma.InputJsonValue,
      },
    });
  }

  /** Drops the oldest terminal steps past the cap. */
  private async trim(kind: 'run' | 'session', id: string): Promise<void> {
    if (kind === 'run') {
      const where = {
        runId: id,
        phase: TERMINAL_PHASE,
      };
      const old = await this.prisma.agentRunEvent.findMany({
        where,
        orderBy: { at: 'desc' },
        skip: MAX_TERMINAL_EVENTS,
        select: { id: true },
      });
      if (old.length > 0) {
        await this.prisma.agentRunEvent.deleteMany({
          where: { id: { in: old.map((row) => row.id) } },
        });
      }
      return;
    }

    const old = await this.prisma.agentSessionEvent.findMany({
      where: { sessionId: id },
      orderBy: { at: 'desc' },
      skip: MAX_TERMINAL_EVENTS,
      select: { id: true },
    });
    if (old.length > 0) {
      await this.prisma.agentSessionEvent.deleteMany({
        where: { id: { in: old.map((row) => row.id) } },
      });
    }
  }
}

function entryAt(entry: unknown): Date | null {
  const stamp = (entry as { timestamp?: unknown } | null)?.timestamp;
  const at = typeof stamp === 'string' ? new Date(stamp) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}

function toRow(step: SessionStep) {
  return {
    at: step.at,
    level: step.level,
    message: step.message,
    phase: TERMINAL_PHASE,
    data: {
      ...(step.data ?? {}),
      source: 'terminal',
    } as Prisma.InputJsonValue,
  };
}

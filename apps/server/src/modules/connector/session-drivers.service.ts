import type { ConnectorPeer } from './connector.registry';
import type { Prisma } from '@prisma/client';
import type { ConnectorAck, ConnectorSessionDriver } from '@vantikhq/types';

import { Injectable } from '@nestjs/common';
import { ompResumeId, SESSION_DRIVER_LEASE_MS } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

/** How far back a session counts as one to watch. */
const WATCH_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The most sessions the server sends to one connector, or reads from one. */
const MAX_SESSIONS = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Which omp sessions a person's connector watches, and what the connector
 * reports about who holds them.
 *
 * Sessions of two kinds are the person's own. The hooks write a row for a
 * terminal session under the person's id. A local run writes a row under the
 * id of the personal agent, and the run records who delegated it.
 */
@Injectable()
export class SessionDriversService {
  constructor(private readonly prisma: PrismaService) {}

  private owned(peer: ConnectorPeer): Prisma.AgentSessionWhereInput {
    return {
      workspaceId: peer.workspaceId,
      deleted: null,
      location: 'LOCAL',
      harness: 'omp',
      channel: { in: ['HOOKS', 'CONNECTOR'] },
      OR: [
        { actorUserId: peer.userId },
        { agentRun: { createdById: peer.userId } },
      ],
    };
  }

  /** The omp session uuids the connector must check, active in the last day. */
  async watchList(
    peer: ConnectorPeer,
    now: Date = new Date(),
  ): Promise<string[]> {
    const rows = await this.prisma.agentSession.findMany({
      where: {
        ...this.owned(peer),
        lastActiveAt: { gte: new Date(now.getTime() - WATCH_WINDOW_MS) },
      },
      select: { externalId: true, harness: true, agentRunId: true },
      orderBy: { lastActiveAt: 'desc' },
      take: MAX_SESSIONS,
    });

    const ids = new Set<string>();

    for (const row of rows) {
      const id = ompResumeId({ ...row, location: 'LOCAL' });

      if (id) {
        ids.add(id);
      }
    }

    return [...ids];
  }

  /**
   * Records who holds each session. Only the person's own sessions change; a
   * uuid that belongs to somebody else matches no row. The lease runs out
   * after a minute, so a connector that went away stops claiming a driver.
   */
  async applyDrivers(
    peer: ConnectorPeer,
    sessions: unknown,
    now: Date = new Date(),
  ): Promise<ConnectorAck> {
    if (!Array.isArray(sessions)) {
      return { ok: false, reason: 'Send sessions as a list.' };
    }

    const lease = new Date(now.getTime() + SESSION_DRIVER_LEASE_MS);

    for (const entry of sessions.slice(
      0,
      MAX_SESSIONS,
    ) as Array<Partial<ConnectorSessionDriver> | null>) {
      const id = entry?.externalId;
      const driver = entry?.driver;

      if (
        typeof id !== 'string' ||
        !UUID.test(id) ||
        (driver !== null && driver !== 'TERMINAL' && driver !== 'VANTIK')
      ) {
        continue;
      }

      const where = {
        ...this.owned(peer),
        // The hooks write `omp:<uuid>`; the connector writes the bare uuid.
        externalId: { in: [id, `omp:${id}`] },
      };

      if (driver === null) {
        // The terminal let go of a session it had opened again, so the
        // session ends again. A Vantik run ends its session itself.
        await this.prisma.agentSession.updateMany({
          where: { ...where, driver: 'TERMINAL', endedAt: null },
          data: { endedAt: now },
        });
      }

      await this.prisma.agentSession.updateMany({
        where,
        data: {
          driver,
          driverLeaseExpiresAt: driver ? lease : null,
          // A person can resume a session after its run ended. While the
          // terminal holds it, the session is live again.
          ...(driver === 'TERMINAL' ? { endedAt: null, lastActiveAt: now } : {}),
        },
      });
    }

    return { ok: true };
  }
}

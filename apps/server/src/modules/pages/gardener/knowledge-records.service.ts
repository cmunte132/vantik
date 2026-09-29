import type {
  KnowledgeBackoffRecord,
  KnowledgeMaintenanceRecord,
  KnowledgeRecordsQueryDto,
  KnowledgeRelationRecord,
  KnowledgeSignalRecord,
  KnowledgeUseRecord,
} from '@vantikhq/types';

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

/** How many rows a read returns when the caller names no limit. */
const DEFAULT_LIMIT = 100;

/**
 * Reads the records the gardener keeps about entries, which had no route:
 * how entries relate, who was given them, what runs said about them, what
 * the gardener did to them, and when a decision type stopped acting alone.
 *
 * Two of these models have no workspace column. A relation is read only
 * when both of its entries are in the workspace, and a signal only when its
 * entry and its run are, so a row that joins two workspaces is never read
 * from either.
 */
@Injectable()
export default class KnowledgeRecordsService {
  constructor(private prisma: PrismaService) {}

  async relations(
    workspaceId: string,
    query: KnowledgeRecordsQueryDto,
  ): Promise<KnowledgeRelationRecord[]> {
    const where: Prisma.PageEntryRelationWhereInput = {
      from: { workspaceId },
      to: { workspaceId },
      ...since(query),
      ...(query.entryId
        ? { OR: [{ fromId: query.entryId }, { toId: query.entryId }] }
        : {}),
    };

    return this.prisma.pageEntryRelation.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit(query),
      select: {
        id: true,
        createdAt: true,
        fromId: true,
        toId: true,
        type: true,
        decidedBy: true,
        similarity: true,
        reason: true,
      },
    });
  }

  async uses(
    workspaceId: string,
    query: KnowledgeRecordsQueryDto,
  ): Promise<KnowledgeUseRecord[]> {
    return this.prisma.pageEntryUse.findMany({
      where: {
        workspaceId,
        entry: { workspaceId },
        ...(query.entryId ? { entryId: query.entryId } : {}),
        ...(query.agentRunId ? { agentRunId: query.agentRunId } : {}),
        ...since(query),
      },
      orderBy: { createdAt: 'desc' },
      take: limit(query),
      select: {
        id: true,
        createdAt: true,
        entryId: true,
        agentRunId: true,
        userId: true,
        via: true,
      },
    });
  }

  async signals(
    workspaceId: string,
    query: KnowledgeRecordsQueryDto,
  ): Promise<KnowledgeSignalRecord[]> {
    return this.prisma.pageEntrySignal.findMany({
      where: {
        entry: { workspaceId },
        agentRun: { workspaceId },
        ...(query.entryId ? { entryId: query.entryId } : {}),
        ...(query.agentRunId ? { agentRunId: query.agentRunId } : {}),
        ...since(query),
      },
      orderBy: { createdAt: 'desc' },
      take: limit(query),
      select: {
        id: true,
        createdAt: true,
        entryId: true,
        agentRunId: true,
        source: true,
        kind: true,
        weight: true,
        evidence: true,
      },
    });
  }

  async maintenance(
    workspaceId: string,
    query: KnowledgeRecordsQueryDto,
  ): Promise<KnowledgeMaintenanceRecord[]> {
    return this.prisma.pageEntryMaintenance.findMany({
      where: {
        workspaceId,
        entry: { workspaceId },
        ...(query.entryId ? { entryId: query.entryId } : {}),
        ...since(query),
      },
      orderBy: { createdAt: 'desc' },
      take: limit(query),
      select: {
        id: true,
        createdAt: true,
        entryId: true,
        action: true,
        reason: true,
        issueId: true,
        proposalState: true,
        resolvedAt: true,
        reversedAt: true,
      },
    });
  }

  async backoff(
    workspaceId: string,
    query: KnowledgeRecordsQueryDto,
  ): Promise<KnowledgeBackoffRecord[]> {
    return this.prisma.knowledgeBackoffChange.findMany({
      where: { workspaceId, ...since(query) },
      orderBy: { createdAt: 'desc' },
      take: limit(query),
      select: {
        id: true,
        createdAt: true,
        decision: true,
        backedOff: true,
        kappa: true,
        samples: true,
        floor: true,
      },
    });
  }
}

function since(query: KnowledgeRecordsQueryDto) {
  return query.since ? { createdAt: { gte: new Date(query.since) } } : {};
}

function limit(query: KnowledgeRecordsQueryDto) {
  return query.limit ?? DEFAULT_LIMIT;
}

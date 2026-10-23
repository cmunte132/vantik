import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AGENT_SESSION_EXTERNAL_ID_MAX,
  type LinkAgentSessionDto,
  normalizeAgentSessionHarness,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { assertIssuesVisible, visibleTeamIds } from 'common/team-access';
import { assertIssueInWorkspace } from 'common/workspace-access';

/**
 * The harness a session id names. The omp hooks extension sends `omp:<uuid>`
 * but reports to the server as Claude Code, and an agent may name its harness
 * loosely when it calls `pick_up_task`. The id prefix is the one reliable sign.
 */
function harnessOf(externalId: string, harness?: string | null) {
  return externalId.startsWith('omp:')
    ? 'omp'
    : normalizeAgentSessionHarness(harness);
}

/**
 * The known amounts of calls, kept apart by billing mode and cost basis, and
 * the calls that have no known amount counted apart. Never priced at $0.
 */
function byBilling(
  calls: Array<{
    costUsd: number | null;
    billingMode: string;
    costBasis: string;
  }>,
) {
  const buckets: Record<
    string,
    { costUsd: number; pricedCalls: number; unpricedCalls: number }
  > = {};
  for (const call of calls) {
    const key = `${call.billingMode}/${call.costBasis}`;
    const bucket = buckets[key] ?? {
      costUsd: 0,
      pricedCalls: 0,
      unpricedCalls: 0,
    };
    if (call.costUsd === null) {
      bucket.unpricedCalls += 1;
    } else {
      bucket.costUsd += call.costUsd;
      bucket.pricedCalls += 1;
    }
    buckets[key] = bucket;
  }
  return buckets;
}

/** The part of `AgentTranscript.sources` that the summary reads. */
interface SourceSummary {
  calls?: number;
  legacyTotals?: boolean;
  legacyBaseline?: Record<
    string,
    { costUsd: number; turns: number; unknownCalls: number }
  >;
}

const NO_TOTALS = { costUsd: 0, turns: 0, unknownCalls: 0 };

/**
 * What the claimed calls of one issue cost. Only the known amounts add up;
 * the unknown ones are counted, and the turns are the assistant's requests.
 */
function ledgerOf(
  calls: Array<{
    costUsd: number | null;
    billingMode: string;
    costBasis: string;
    data: unknown;
  }>,
) {
  let costUsd = 0;
  let turns = 0;
  let unknownCalls = 0;
  for (const call of calls) {
    if (call.costUsd === null) {
      unknownCalls += 1;
    } else {
      costUsd += call.costUsd;
    }
    if ((call.data as { purpose?: unknown } | null)?.purpose === 'assistant') {
      turns += 1;
    }
  }
  return { costUsd, turns, unknownCalls, byBilling: byBilling(calls) };
}

/** How much of the root session the record has seen: its own calls and its children's. */
function coverageOf(sources: Record<string, SourceSummary>) {
  const children = Object.entries(sources).filter(([key]) =>
    key.startsWith('child:'),
  );
  return {
    mainCalls: sources.main?.calls ?? 0,
    childSessions: children.length,
    childCalls: children.reduce(
      (sum, [, source]) => sum + (source.calls ?? 0),
      0,
    ),
  };
}

/** The most steps one read returns; a session keeps no more than this. */
const SESSION_EVENT_LIMIT = 2000;

export interface SessionActor {
  userId: string;
  workspaceId: string;
}

/**
 * The sessions that agents run on issues, from any harness and any channel.
 *
 * A hosted run gets its session from `AgentRunsService`. This service holds the
 * rest: a terminal harness that reaches Vantik through the hooks and the MCP
 * server. Hooks do not know the issue, and sessions that run in parallel share
 * one token, so this service never guesses the link. The agent states it when
 * it calls `pick_up_task` with its session id.
 */
@Injectable()
export class AgentSessionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The steps of a session that has no run, oldest first. They are what a
   * person did in their own terminal. The session must be in the caller's
   * workspace and on an issue in a team the caller can see; a hidden session
   * and a missing one give the same answer.
   */
  async listEvents(actor: SessionActor, sessionId: string) {
    const session = await this.prisma.agentSession.findFirst({
      where: { id: sessionId, workspaceId: actor.workspaceId, deleted: null },
      select: { id: true, issueId: true },
    });

    if (!session) {
      throw new NotFoundException('No such session.');
    }

    await assertIssuesVisible(
      this.prisma,
      [session.issueId],
      await visibleTeamIds(this.prisma, actor.userId, actor.workspaceId),
    );

    const events = await this.prisma.agentSessionEvent.findMany({
      where: { sessionId },
      orderBy: { at: 'desc' },
      take: SESSION_EVENT_LIMIT,
    });

    return events.reverse();
  }

  /**
   * What the person's own usage record says about a session.
   *
   * `issue.ledger` is what the claimed calls of this issue cost. Its unknown
   * calls are counted apart and add no cost. `issue.legacy` is what the issue's
   * rows held before the record existed. It is unverified, and it is never added
   * to the ledger. `canonical` is the whole root session, counted once. It
   * includes work that no issue received, which is the owner's private work, so
   * only the owner reads it. Any other viewer gets this issue's ledger and
   * nothing of the session.
   */
  async usageSummary(actor: SessionActor, sessionId: string) {
    const session = await this.prisma.agentSession.findFirst({
      where: { id: sessionId, workspaceId: actor.workspaceId, deleted: null },
      select: {
        issueId: true,
        externalId: true,
        actorUserId: true,
        terminalCostUsd: true,
        terminalTurns: true,
        terminalUnknownCalls: true,
        agentRun: { select: { createdById: true } },
      },
    });

    if (!session) {
      throw new NotFoundException('No such session.');
    }

    await assertIssuesVisible(
      this.prisma,
      [session.issueId],
      await visibleTeamIds(this.prisma, actor.userId, actor.workspaceId),
    );

    // The record belongs to the person who runs the session.
    const owner = session.agentRun?.createdById ?? session.actorUserId;
    const rootId = session.externalId.replace(/^omp:/, '');
    const transcript = await this.prisma.agentTranscript.findFirst({
      where: {
        workspaceId: actor.workspaceId,
        actorUserId: owner,
        harness: 'omp',
        externalId: rootId,
      },
      select: {
        id: true,
        knownCostUsd: true,
        unattributedCostUsd: true,
        unknownCallCount: true,
        billingSummary: true,
        sources: true,
      },
    });

    const sources = (transcript?.sources ?? {}) as Record<
      string,
      SourceSummary
    >;
    const legacy = transcript
      ? sources.main?.legacyTotals
        ? (sources.main.legacyBaseline?.[session.issueId] ?? NO_TOTALS)
        : null
      : session.terminalCostUsd > 0 ||
          session.terminalTurns > 0 ||
          session.terminalUnknownCalls > 0
        ? {
            costUsd: session.terminalCostUsd,
            turns: session.terminalTurns,
            unknownCalls: session.terminalUnknownCalls,
          }
        : null;

    const calls = transcript
      ? await this.prisma.agentTranscriptCall.findMany({
          where: {
            transcriptId: transcript.id,
            kind: 'call',
            issueId: session.issueId,
          },
          select: {
            costUsd: true,
            billingMode: true,
            costBasis: true,
            data: true,
          },
        })
      : [];

    return {
      issue: {
        ledger: ledgerOf(calls),
        legacy: legacy ? { ...legacy, unverified: true } : null,
      },
      canonical:
        transcript && owner === actor.userId
          ? {
              knownCostUsd: transcript.knownCostUsd,
              unattributedCostUsd: transcript.unattributedCostUsd,
              unknownCallCount: transcript.unknownCallCount,
              byBilling: transcript.billingSummary,
              coverage: coverageOf(sources),
              legacyUnverified: sources.main?.legacyTotals === true,
            }
          : null,
    };
  }

  /**
   * Records that a harness session works on an issue. It creates the row or
   * brings the existing one up to date. The session acts as the caller.
   *
   * The issue must be in the caller's workspace and in a team the caller can
   * see. A hidden issue and a missing one give the same answer.
   */
  async linkHookSession(actor: SessionActor, input: LinkAgentSessionDto) {
    const externalId = input.externalId.trim();

    if (!externalId || externalId.length > AGENT_SESSION_EXTERNAL_ID_MAX) {
      throw new RangeError('The session id is empty or too long.');
    }

    await assertIssueInWorkspace(this.prisma, input.issueId, actor.workspaceId);
    await assertIssuesVisible(
      this.prisma,
      [input.issueId],
      await visibleTeamIds(this.prisma, actor.userId, actor.workspaceId),
    );

    const harness = harnessOf(externalId, input.harness);
    const now = new Date();

    return this.prisma.agentSession.upsert({
      where: {
        workspaceId_actorUserId_channel_externalId_issueId: {
          workspaceId: actor.workspaceId,
          actorUserId: actor.userId,
          channel: 'HOOKS',
          externalId,
          issueId: input.issueId,
        },
      },
      create: {
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        issueId: input.issueId,
        externalId,
        harness,
        location: 'LOCAL',
        channel: 'HOOKS',
        driver: 'TERMINAL',
        startedAt: now,
        lastActiveAt: now,
      },
      update: {
        ...(harness ? { harness } : {}),
        lastActiveAt: now,
        // Picking the issue up again resumes a session that had ended.
        endedAt: null,
        deleted: null,
      },
    });
  }

  /**
   * Records that an agent session handed work in through a git inbox, for one
   * issue. It creates the row or brings the existing one up to date, and it
   * raises `lastActiveAt` when the same session hands in again.
   *
   * The inbox is the channel, and nobody says where the agent runs, so the
   * location stays unknown and the driver stays empty. The session acts as
   * `actor`, the integration bot that writes the hand-off. The caller has
   * already limited the issue to the teams that the repository mirrors, so
   * this method checks the workspace only.
   */
  async recordInboxSession(
    actor: SessionActor,
    input: { issueId: string; externalId: string; harness?: string | null },
  ) {
    const externalId = input.externalId.trim();

    if (!externalId || externalId.length > AGENT_SESSION_EXTERNAL_ID_MAX) {
      throw new RangeError('The session id is empty or too long.');
    }

    await assertIssueInWorkspace(this.prisma, input.issueId, actor.workspaceId);

    const harness = harnessOf(externalId, input.harness);
    const now = new Date();

    return this.prisma.agentSession.upsert({
      where: {
        workspaceId_actorUserId_channel_externalId_issueId: {
          workspaceId: actor.workspaceId,
          actorUserId: actor.userId,
          channel: 'GIT_INBOX',
          externalId,
          issueId: input.issueId,
        },
      },
      create: {
        workspaceId: actor.workspaceId,
        actorUserId: actor.userId,
        issueId: input.issueId,
        externalId,
        harness,
        location: 'UNKNOWN',
        channel: 'GIT_INBOX',
        startedAt: now,
        lastActiveAt: now,
      },
      update: {
        ...(harness ? { harness } : {}),
        lastActiveAt: now,
        endedAt: null,
        deleted: null,
      },
    });
  }

  /**
   * Marks the hooks sessions of one harness session as active now. A hook
   * knows the session id and the caller, and does not know the issue, so this
   * touches every row the caller has under that id. A known harness name fills
   * a row that has none, or corrects one that says other.
   *
   * Returns how many rows it touched.
   */
  async touchHookSession(
    actor: SessionActor,
    externalId: string,
    harness?: string | null,
    now = new Date(),
  ): Promise<number> {
    const where: Prisma.AgentSessionWhereInput = {
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      channel: 'HOOKS',
      externalId,
      deleted: null,
    };

    const { count } = await this.prisma.agentSession.updateMany({
      where,
      data: { lastActiveAt: now },
    });

    const name = harnessOf(externalId, harness);

    // The hook names its harness from a fixed list, so it also corrects an
    // 'other' that a free-text pick_up_task argument wrote.
    if (count > 0 && name && name !== 'other') {
      await this.prisma.agentSession.updateMany({
        where: {
          ...where,
          OR: [
            { harness: null },
            { harness: 'other' },
            // The prefix is certain, so it also corrects a loose name.
            ...(externalId.startsWith('omp:')
              ? [{ harness: { not: name } }]
              : []),
          ],
        },
        data: { harness: name },
      });
    }

    return count;
  }
}

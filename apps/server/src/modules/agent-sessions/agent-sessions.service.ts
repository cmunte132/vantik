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

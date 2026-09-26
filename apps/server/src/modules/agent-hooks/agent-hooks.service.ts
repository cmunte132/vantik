import { createHash } from 'crypto';

import { Injectable } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import { CacheService } from 'modules/cache/cache.service';
import { LoggerService } from 'modules/logger/logger.service';

import { HookEvent, HookInput } from './agent-hooks.harness';
import {
  InProgressIssue,
  sessionBrief,
  stopReason,
} from './agent-hooks.messages';

/**
 * How long an issue this agent has in progress may go without a word from it
 * before a stop is held up. The skill names twenty minutes of edits the
 * tracker knows nothing about as the failure, so this is that line, enforced.
 */
export const QUIET_MS = 20 * 60_000;

/**
 * A session nobody has prompted for this long is starting over when it is
 * prompted again — resumed the next morning, say — and is briefed and timed
 * afresh rather than judged on yesterday's silence.
 */
export const IDLE_MS = 60 * 60_000;

/** Long enough to outlive any session worth judging; the store forgets. */
const STATE_TTL_SECONDS = 2 * 24 * 60 * 60;

/** A brief is a glance, not a board. */
const MAX_ISSUES = 10;

export interface HookActor {
  userId: string;
  workspaceId: string;
}

/**
 * What the hooks remember about one session, all in ms. Kept in redis rather
 * than the database: it is small, short-lived, and worthless once the session
 * is over.
 */
interface SessionState {
  /** When the current stretch of the session began. */
  startedAt: number;
  /** The last hook heard from it, which is how a resumed session is told apart. */
  seenAt: number;
  /** Issue id → when this session was last held up over it. */
  nudged: Record<string, number>;
}

/**
 * The rules behind the hooks: what an agent is told when a session begins, and
 * whether it may stop.
 *
 * A skill can only advise, and the failure it advises against — an hour of
 * work the tracker never hears about — is the one an agent does not notice it
 * is committing. So the check that matters is made here, against what the
 * tracker actually records, and the harness only relays the answer.
 */
@Injectable()
export class AgentHooksService {
  private readonly logger = new LoggerService('AgentHooksService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /**
   * What the hook should say, or null to say nothing.
   *
   * Never throws. A hook that errors is a hook the person running the agent
   * has to diagnose, and one that blocks on an error is worse; whatever goes
   * wrong in here, the agent carries on exactly as if the hook were not there.
   */
  async run(
    event: HookEvent,
    actor: HookActor,
    input: HookInput,
  ): Promise<string | null> {
    if (!input.sessionId) {
      return null;
    }

    try {
      switch (event) {
        case 'session-start':
          return await this.sessionStart(actor, input.sessionId, input);
        case 'prompt':
          return await this.prompt(actor, input.sessionId);
        case 'stop':
          return await this.stop(actor, input.sessionId, input);
      }
    } catch (error) {
      this.logger.error({
        message: `Agent hook "${event}" failed: ${(error as Error).message}`,
        where: 'AgentHooksService.run',
        error: error as Error,
      });
    }

    return null;
  }

  private async sessionStart(
    actor: HookActor,
    sessionId: string,
    input: HookInput,
  ): Promise<string> {
    const now = Date.now();
    const state = await this.load(actor, sessionId);

    // Compaction continues the same session, so its clock keeps running. The
    // brief is still worth repeating: the summary may not have kept it.
    await this.save(
      actor,
      sessionId,
      input.source === 'compact' && state
        ? { ...state, seenAt: now }
        : fresh(now),
    );

    return sessionBrief(await this.inProgress(actor), now);
  }

  /** The first prompt of a stretch is briefed; the rest pass untouched. */
  private async prompt(
    actor: HookActor,
    sessionId: string,
  ): Promise<string | null> {
    const now = Date.now();
    const state = await this.load(actor, sessionId);

    if (state && now - state.seenAt < IDLE_MS) {
      await this.save(actor, sessionId, { ...state, seenAt: now });
      return null;
    }

    await this.save(actor, sessionId, fresh(now));

    return sessionBrief(await this.inProgress(actor), now);
  }

  /**
   * Holds up a stop when an issue this agent has in progress has gone quiet
   * for {@link QUIET_MS} of this session — once for each quiet stretch.
   *
   * Quiet is measured from whichever is later: the start of the session's
   * current stretch, or the agent's last word on the issue. So a session
   * shorter than the threshold is never held up, however stale the issue, and
   * a long one is held up over the silence it caused rather than one it
   * inherited. After a nudge, only a new word on the issue starts a stretch
   * that can earn another.
   */
  private async stop(
    actor: HookActor,
    sessionId: string,
    input: HookInput,
  ): Promise<string | null> {
    // The harness is already continuing because a stop hook asked it to.
    if (input.continued) {
      return null;
    }

    const state = await this.load(actor, sessionId);

    // Without a start there is no telling what this session left quiet. It
    // happens when the start hook is not installed, or the store was down
    // then, and either way the answer is to let the agent stop.
    if (!state) {
      return null;
    }

    const now = Date.now();

    const stale = (await this.inProgress(actor))
      .map((issue) => ({
        ...issue,
        quietSince: Math.max(state.startedAt, issue.lastWrite ?? 0),
      }))
      .filter((issue) => {
        const nudgedAt = state.nudged[issue.id];

        return (
          now - issue.quietSince >= QUIET_MS &&
          (nudgedAt === undefined || nudgedAt < issue.quietSince)
        );
      });

    const nudged = { ...state.nudged };

    for (const issue of stale) {
      nudged[issue.id] = now;
    }

    const recorded = await this.save(actor, sessionId, {
      ...state,
      seenAt: now,
      nudged,
    });

    // Only once the nudge is on record. Unrecorded, the next stop would find
    // the same silence and hold the agent up again — every turn, for as long
    // as the store was down — which is the one outcome worse than no hook.
    if (stale.length === 0 || !recorded) {
      return null;
    }

    return stopReason(stale, now);
  }

  /**
   * The issues assigned to this agent in a started state, with how far their
   * Definition of Done has got and when the agent last recorded anything.
   *
   * "Recorded anything" is any of the writes the skill asks for — a note, a
   * criterion ticked or added, a change to the issue itself — and only the
   * agent's own: someone else commenting does not bring its issue up to date.
   */
  private async inProgress({
    userId,
    workspaceId,
  }: HookActor): Promise<InProgressIssue[]> {
    const started = await this.prisma.workflow.findMany({
      where: {
        category: 'STARTED',
        deleted: null,
        team: { workspaceId, deleted: null },
      },
      select: { id: true },
    });

    if (started.length === 0) {
      return [];
    }

    const issues = await this.prisma.issue.findMany({
      where: {
        assigneeId: userId,
        deleted: null,
        stateId: { in: started.map((state) => state.id) },
      },
      select: {
        id: true,
        number: true,
        title: true,
        updatedAt: true,
        updatedById: true,
        team: { select: { identifier: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: MAX_ISSUES,
    });

    if (issues.length === 0) {
      return [];
    }

    const ids = issues.map((issue) => issue.id);

    const [criteria, notes, history, criteriaWrites] = await Promise.all([
      this.prisma.checklistItem.groupBy({
        by: ['issueId', 'completed'],
        where: { issueId: { in: ids }, deleted: null },
        _count: { _all: true },
      }),
      this.prisma.issueComment.groupBy({
        by: ['issueId'],
        where: { issueId: { in: ids }, userId },
        _max: { createdAt: true },
      }),
      this.prisma.issueHistory.groupBy({
        by: ['issueId'],
        where: { issueId: { in: ids }, userId },
        _max: { createdAt: true },
      }),
      this.prisma.checklistItem.groupBy({
        by: ['issueId'],
        where: {
          issueId: { in: ids },
          OR: [{ updatedById: userId }, { createdById: userId }],
        },
        _max: { updatedAt: true },
      }),
    ]);

    return issues.map((issue) => {
      const rows = criteria.filter((row) => row.issueId === issue.id);
      const writes = [
        issue.updatedById === userId ? issue.updatedAt : null,
        notes.find((row) => row.issueId === issue.id)?._max.createdAt,
        history.find((row) => row.issueId === issue.id)?._max.createdAt,
        criteriaWrites.find((row) => row.issueId === issue.id)?._max.updatedAt,
      ]
        .filter((at): at is Date => at instanceof Date)
        .map((at) => at.getTime());

      return {
        id: issue.id,
        key: `${issue.team.identifier}-${issue.number}`,
        title: issue.title,
        criteria: {
          completed: rows
            .filter((row) => row.completed)
            .reduce((sum, row) => sum + row._count._all, 0),
          total: rows.reduce((sum, row) => sum + row._count._all, 0),
        },
        lastWrite: writes.length > 0 ? Math.max(...writes) : null,
      };
    });
  }

  private async load(
    actor: HookActor,
    sessionId: string,
  ): Promise<SessionState | null> {
    const raw = await this.cache.get(stateKey(actor, sessionId));

    if (!raw) {
      return null;
    }

    try {
      const state = JSON.parse(raw) as SessionState;
      return typeof state.startedAt === 'number' ? state : null;
    } catch {
      return null;
    }
  }

  /** False when the store could not take it. */
  private async save(
    actor: HookActor,
    sessionId: string,
    state: SessionState,
  ): Promise<boolean> {
    try {
      return (
        (await this.cache.set(
          stateKey(actor, sessionId),
          JSON.stringify(state),
          STATE_TTL_SECONDS,
        )) === 'OK'
      );
    } catch (error) {
      this.logger.error({
        message: `Could not record agent hook state: ${(error as Error).message}`,
        where: 'AgentHooksService.save',
        error: error as Error,
      });
      return false;
    }
  }
}

function fresh(now: number): SessionState {
  return { startedAt: now, seenAt: now, nudged: {} };
}

/**
 * Per account and session. The session id is the harness's and arrives from
 * outside, so it is hashed rather than trusted into a key.
 */
function stateKey({ userId }: HookActor, sessionId: string): string {
  const session = createHash('sha256').update(sessionId).digest('hex');

  return `agent-hooks:${userId}:${session.slice(0, 32)}`;
}

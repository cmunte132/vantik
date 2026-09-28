import { createHash } from 'crypto';

import { Injectable } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import { CacheService } from 'modules/cache/cache.service';
import { LoggerService } from 'modules/logger/logger.service';
import { KnowledgeSearchHit } from 'modules/vector/vector.interface';
import { VectorService } from 'modules/vector/vector.service';

import { HookEvent, HookInput } from './agent-hooks.harness';
import {
  InProgressIssue,
  KnowledgePointer,
  knowledgePointers,
  sessionBrief,
  stopReason,
  untrackedStopReason,
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

/**
 * A session must change files this number of times before the stop check asks
 * for an issue. One or two edits are usually a small fix. The skill asks for
 * few, large issues.
 */
export const EDITS_WORTH_AN_ISSUE = 5;

/**
 * A shorter prompt, for example "yes" or "go on", continues the work. It is not
 * a new question, so the service does not search the knowledge bank for it.
 */
export const MIN_POINTER_PROMPT_LENGTH = 20;

/**
 * The maximum vector distance for a pointer to a page. This value is tighter
 * than the 0.8 of `load_context`. A pointer that the agent receives on each
 * prompt must be precise, or the agent learns to ignore all of them.
 */
export const POINTER_DISTANCE = 0.6;

/** The maximum number of pages in one message of pointers. */
const MAX_POINTERS = 3;

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
  /** The number of files the agent changed in this stretch. */
  edits: number;
  /** When the hook held up the session for work with no issue, or null. */
  untrackedNudgedAt: number | null;
  /** The pages that the hook named to this session. It names each page once. */
  pointed: string[];
  /**
   * The messages that the harness could not take when the service made them.
   * The next hook that can add context gives them to the agent.
   */
  pending: string[];
}

/**
 * The maximum number of kept messages. A newer brief or set of pointers is
 * more correct than an older one, so the service discards the oldest.
 */
const MAX_PENDING = 3;

/**
 * The tools that change a file, by the name each harness reports. Claude Code
 * and Codex send only these, because their matchers filter the hook. Cursor
 * sends every tool, so the service must select the edits.
 */
const EDIT_TOOLS = [
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'apply_patch',
  'Delete',
];

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
    private readonly vector: VectorService,
  ) {}

  /**
   * What the hook should say, or null to say nothing.
   *
   * Never throws. A hook that errors is a hook the person running the agent
   * has to diagnose, and one that blocks on an error is worse; whatever goes
   * wrong in here, the agent carries on exactly as if the hook were not there.
   *
   * `canSay` is false when the harness cannot add context on this event, for
   * example Cursor on a prompt. The service then keeps the message, and the
   * next `tool-use` hook that can add context gives it to the agent.
   */
  async run(
    event: HookEvent,
    actor: HookActor,
    input: HookInput,
    { canSay = true }: { canSay?: boolean } = {},
  ): Promise<string | null> {
    const { sessionId } = input;

    if (!sessionId) {
      return null;
    }

    try {
      const text = await this.decide(event, actor, sessionId, input, canSay);

      if (text && !canSay) {
        await this.keep(actor, sessionId, text);
        return null;
      }

      return text;
    } catch (error) {
      this.logger.error({
        message: `Agent hook "${event}" failed: ${(error as Error).message}`,
        where: 'AgentHooksService.run',
        error: error as Error,
      });
    }

    return null;
  }

  private async decide(
    event: HookEvent,
    actor: HookActor,
    sessionId: string,
    input: HookInput,
    canSay: boolean,
  ): Promise<string | null> {
    switch (event) {
      case 'session-start':
        return this.sessionStart(actor, sessionId, input);
      case 'compact':
        return this.sessionStart(actor, sessionId, {
          ...input,
          source: 'compact',
        });
      case 'prompt':
        return this.prompt(actor, sessionId, input);
      case 'tool-use':
        return this.toolUse(actor, sessionId, input, canSay);
      case 'stop':
        return this.stop(actor, sessionId, input);
    }
  }

  /** This method keeps a message for the next hook that can add context. */
  private async keep(
    actor: HookActor,
    sessionId: string,
    text: string,
  ): Promise<void> {
    const state = await this.load(actor, sessionId);

    if (state) {
      await this.save(actor, sessionId, {
        ...state,
        pending: [...state.pending, text].slice(-MAX_PENDING),
      });
    }
  }

  private async sessionStart(
    actor: HookActor,
    sessionId: string,
    input: HookInput,
  ): Promise<string> {
    const now = Date.now();
    const state = await this.load(actor, sessionId);

    // Compaction continues the same session, so its clock keeps running. The
    // brief is still worth repeating: the summary may not have kept it. The
    // summary can also lose the pointers, so the hook can name each page again.
    await this.save(
      actor,
      sessionId,
      input.source === 'compact' && state
        ? { ...state, seenAt: now, pointed: [] }
        : fresh(now),
    );

    return sessionBrief(await this.inProgress(actor), now);
  }

  /**
   * The hook gives a brief on the first prompt of a stretch. On each prompt,
   * it also names the pages of the knowledge bank that match the prompt. It
   * does not name a page again in the same session.
   */
  private async prompt(
    actor: HookActor,
    sessionId: string,
    input: HookInput,
  ): Promise<string | null> {
    const now = Date.now();
    const previous = await this.load(actor, sessionId);
    const continuing = previous && now - previous.seenAt < IDLE_MS;
    const state = continuing ? { ...previous, seenAt: now } : fresh(now);

    const [brief, pointers] = await Promise.all([
      continuing
        ? null
        : this.inProgress(actor).then((issues) => sessionBrief(issues, now)),
      this.pointers(actor, input.prompt, state.pointed),
    ]);

    await this.save(actor, sessionId, {
      ...state,
      pointed: [...state.pointed, ...pointers.map((pointer) => pointer.pageId)],
    });

    const said = [brief, pointers.length ? knowledgePointers(pointers) : null];

    return said.filter(Boolean).join('\n\n') || null;
  }

  /**
   * A tool finished. If the tool changed a file, this method counts one edit.
   * If the harness can add context here, the method also gives the agent the
   * kept messages.
   *
   * If the service has no record of the session, it does nothing. The stop
   * check lets such a session stop. The method writes only when something
   * changed, because Cursor calls this hook for each tool.
   */
  private async toolUse(
    actor: HookActor,
    sessionId: string,
    input: HookInput,
    canSay: boolean,
  ): Promise<string | null> {
    const state = await this.load(actor, sessionId);

    if (!state) {
      return null;
    }

    // A harness that sends no tool name filtered the hook to the edit tools.
    const edited =
      input.toolName === null || EDIT_TOOLS.includes(input.toolName);
    const said = canSay && state.pending.length > 0 ? state.pending : [];

    if (!edited && said.length === 0) {
      return null;
    }

    const recorded = await this.save(actor, sessionId, {
      ...state,
      seenAt: Date.now(),
      edits: state.edits + (edited ? 1 : 0),
      pending: said.length > 0 ? [] : state.pending,
    });

    // A message that the store did not clear comes back on the next tool. It
    // is better to give it once, late, than to give it on every tool.
    return recorded && said.length > 0 ? said.join('\n\n') : null;
  }

  /**
   * This method returns the pages of the knowledge bank that match a prompt,
   * the closest first. It removes the pages that the session got before.
   *
   * The search goes directly to the index, and not through KnowledgeService.
   * KnowledgeService records each served item as demand, and a query with no
   * result as a gap. A hook is not a request from an agent, so it must not
   * change either record.
   */
  private async pointers(
    { workspaceId }: HookActor,
    prompt: string | null,
    pointed: string[],
  ): Promise<Array<KnowledgePointer & { pageId: string }>> {
    if (!prompt || prompt.length < MIN_POINTER_PROMPT_LENGTH) {
      return [];
    }

    let hits: KnowledgeSearchHit[];

    // If the search fails, the prompt gets no pointers. It still gets its
    // brief.
    try {
      ({ hits } = await this.vector.searchKnowledge(workspaceId, prompt, {
        limit: 10,
        vectorDistance: POINTER_DISTANCE,
      }));
    } catch (error) {
      this.logger.error({
        message: `Could not search knowledge for a hook: ${(error as Error).message}`,
        where: 'AgentHooksService.pointers',
        error: error as Error,
      });
      return [];
    }

    const pages = new Map<string, KnowledgePointer & { pageId: string }>();

    for (const hit of hits) {
      // A hit that matched only by its words has no distance. Such a match is
      // too weak to interrupt the agent.
      if (
        hit.distance === undefined ||
        hit.distance > POINTER_DISTANCE ||
        pointed.includes(hit.pageId)
      ) {
        continue;
      }

      const page = pages.get(hit.pageId);

      if (page) {
        page.matches += 1;
        page.scope ??= hit.scope;
      } else {
        pages.set(hit.pageId, {
          pageId: hit.pageId,
          title: hit.pageTitle || hit.title,
          matches: 1,
          scope: hit.scope,
        });
      }
    }

    return [...pages.values()].slice(0, MAX_POINTERS);
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
    const issues = await this.inProgress(actor);

    const stale = issues
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

    // This is work with no issue: the session changed files, and nothing is
    // in progress under the name of the agent. The hook asks one time for
    // each stretch. The answer "this work is not for Vantik" stays true for
    // the remainder of the stretch.
    const untracked =
      issues.length === 0 &&
      state.edits >= EDITS_WORTH_AN_ISSUE &&
      state.untrackedNudgedAt === null;

    if (stale.length === 0 && !untracked) {
      await this.save(actor, sessionId, { ...state, seenAt: now });
      return null;
    }

    const nudged = { ...state.nudged };

    for (const issue of stale) {
      nudged[issue.id] = now;
    }

    const recorded = await this.save(actor, sessionId, {
      ...state,
      seenAt: now,
      nudged,
      untrackedNudgedAt: untracked ? now : state.untrackedNudgedAt,
    });

    // Only once the nudge is on record. Unrecorded, the next stop would find
    // the same silence and hold the agent up again — every turn, for as long
    // as the store was down — which is the one outcome worse than no hook.
    if (!recorded) {
      return null;
    }

    return untracked
      ? untrackedStopReason(state.edits)
      : stopReason(stale, now);
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
      const state = JSON.parse(raw) as Partial<SessionState>;

      if (typeof state.startedAt !== 'number') {
        return null;
      }

      // A record from before a field existed gets the start value of that
      // field.
      return {
        ...fresh(state.startedAt),
        ...state,
      } as SessionState;
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
  return {
    startedAt: now,
    seenAt: now,
    nudged: {},
    edits: 0,
    untrackedNudgedAt: null,
    pointed: [],
    pending: [],
  };
}

/**
 * Per account and session. The session id is the harness's and arrives from
 * outside, so it is hashed rather than trusted into a key.
 */
function stateKey({ userId }: HookActor, sessionId: string): string {
  const session = createHash('sha256').update(sessionId).digest('hex');

  return `agent-hooks:${userId}:${session.slice(0, 32)}`;
}

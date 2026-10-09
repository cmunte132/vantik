import type { ContextPack } from './context-pack.service';
import type { OutboxItem } from './pi-extension/vantik-extension';

import { Injectable, Logger } from '@nestjs/common';
import {
  AGENT_QUESTION_DEFAULT_WAIT_MS,
  AGENT_QUESTION_EXTERNAL_ID_PATTERN,
  AGENT_QUESTION_LIMITS,
  AGENT_QUESTION_MAX_WAIT_MS,
  type AgentQuestionItem,
  PageEntryKindEnum,
  parseAgentQuestions,
} from '@vantikhq/types';

import { AgentQuestionsService } from 'modules/agent-questions/agent-questions.service';
import ChecklistItemsService from 'modules/checklist-items/checklist-items.service';
import IssueCommentsService from 'modules/issue-comments/issue-comments.service';
import PageEntriesService from 'modules/pages/page-entries.service';

/**
 * What an agent asked to write to Vantik during a session, checked and applied
 * on the host. A hosted run is one kind of session; any channel can use it.
 *
 * The guest holds no Vantik credential. The Vantik tools in the Pi extension
 * append lines to an outbox file in the guest, and the host reads it after
 * each pass. Everything in the file is untrusted: the agent can write it with
 * its shell, and a prompt-injected agent will. So every line is checked here
 * against the run — the shape, the size, the per-run caps, and for a
 * criterion, that it is one of this issue's — and what passes is applied as
 * the run's agent, never as anybody with more reach:
 *
 * - a note becomes a comment on the run's issue, and only that issue;
 * - a fact becomes a PROPOSED entry, which triage still has to accept;
 * - a criterion is ticked only when the run succeeds, because "met" is a claim
 *   the run's checks and reviewer have to stand behind;
 * - a question becomes an open question for the person who started the run.
 *   The agent waits for the answer, so it is applied at once and not at the
 *   end of the pass.
 */

export const OUTBOX_LIMITS = {
  notes: 10,
  facts: 10,
  noteLength: 4000,
  /** The same bound remember holds an agent's fact to over MCP. */
  factLength: 600,
  evidenceLength: 1000,
  citations: 5,
  /** Lines read in one run, valid or not. */
  lines: 200,
  /** Questions one run may ask a person. */
  questions: AGENT_QUESTION_LIMITS.perRun,
};

export interface OutboxRejection {
  line: number;
  reason: string;
}

export interface OutboxBatch {
  notes: Array<{ body: string }>;
  facts: Array<{
    content: string;
    kind: PageEntryKindEnum;
    citations: Array<{ path: string; lines?: string }>;
  }>;
  criteria: Array<{ id: string; evidence: string }>;
  questions: Array<{
    id: string;
    questions: AgentQuestionItem[];
    /** The latest moment the agent still waits, from its own clock. */
    expiresAt?: Date;
  }>;
  /** Question lines that were refused, by the id the agent gave. */
  refusedQuestions: Array<{ id: string; reason: string }>;
  rejected: OutboxRejection[];
}

/** How much of the outbox one run has used, carried from pass to pass. */
export interface OutboxState {
  /** Lines already read. The file only grows; earlier lines are not re-read. */
  lines: number;
  notes: number;
  facts: number;
  questions: number;
  /** Criteria claimed met, by id, applied when the run succeeds. */
  criteria: Map<string, string>;
}

export const newOutboxState = (): OutboxState => ({
  lines: 0,
  notes: 0,
  facts: 0,
  questions: 0,
  criteria: new Map(),
});

const KINDS = new Set<string>(Object.values(PageEntryKindEnum));

/**
 * The new lines of an outbox, checked. Pure: it reads `state` and returns what
 * to apply, and advances `state` past what it read.
 */
export function readOutbox(
  text: string,
  pack: Pick<ContextPack, 'definitionOfDone'>,
  state: OutboxState,
): OutboxBatch {
  const batch: OutboxBatch = {
    notes: [],
    facts: [],
    criteria: [],
    questions: [],
    refusedQuestions: [],
    rejected: [],
  };
  // The piece after the last newline is either empty or a line still being
  // written; it is read next time, once it is complete.
  const complete = text.split('\n').slice(0, -1);
  const criterionIds = new Set(pack.definitionOfDone.map((c) => c.id));

  for (let index = state.lines; index < complete.length; index += 1) {
    state.lines = index + 1;
    const line = index + 1;

    if (index >= OUTBOX_LIMITS.lines) {
      batch.rejected.push({ line, reason: 'past the outbox limit' });
      continue;
    }

    let item: Partial<OutboxItem> & Record<string, unknown>;
    try {
      item = JSON.parse(complete[index]);
    } catch {
      batch.rejected.push({ line, reason: 'not JSON' });
      continue;
    }
    if (!item || typeof item !== 'object' || item.v !== 1) {
      batch.rejected.push({ line, reason: 'unknown record' });
      continue;
    }

    if (item.type === 'note') {
      const body = typeof item.body === 'string' ? item.body.trim() : '';
      if (!body) {
        batch.rejected.push({ line, reason: 'empty note' });
      } else if (state.notes >= OUTBOX_LIMITS.notes) {
        batch.rejected.push({ line, reason: 'too many notes' });
      } else {
        state.notes += 1;
        batch.notes.push({ body: body.slice(0, OUTBOX_LIMITS.noteLength) });
      }
      continue;
    }

    if (item.type === 'remember') {
      const content =
        typeof item.content === 'string' ? item.content.trim() : '';
      if (!content || content.length > OUTBOX_LIMITS.factLength) {
        batch.rejected.push({ line, reason: 'empty or oversized fact' });
      } else if (state.facts >= OUTBOX_LIMITS.facts) {
        batch.rejected.push({ line, reason: 'too many facts' });
      } else {
        state.facts += 1;
        batch.facts.push({
          content,
          kind:
            typeof item.kind === 'string' && KINDS.has(item.kind)
              ? (item.kind as PageEntryKindEnum)
              : PageEntryKindEnum.FACT,
          citations: citationsOf(item.citations),
        });
      }
      continue;
    }

    if (item.type === 'criterion') {
      const id = typeof item.id === 'string' ? item.id : '';
      const evidence =
        typeof item.evidence === 'string' ? item.evidence.trim() : '';
      if (!criterionIds.has(id)) {
        batch.rejected.push({ line, reason: 'not a criterion of this issue' });
      } else if (!evidence) {
        batch.rejected.push({ line, reason: 'no evidence' });
      } else {
        const trimmed = evidence.slice(0, OUTBOX_LIMITS.evidenceLength);
        state.criteria.set(id, trimmed);
        batch.criteria.push({ id, evidence: trimmed });
      }
      continue;
    }

    if (item.type === 'question') {
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      const questions = parseAgentQuestions(item.questions);

      const usable = AGENT_QUESTION_EXTERNAL_ID_PATTERN.test(id);
      // The agent waits on a usable id, so it is told when the line is refused.
      const refuse = (reason: string, detail = reason) => {
        batch.rejected.push({ line, reason });
        if (usable) {
          batch.refusedQuestions.push({ id, reason: detail });
        }
      };
      const deadline =
        typeof item.expiresAt === 'string' ? new Date(item.expiresAt) : null;

      if (!usable) {
        refuse('question without a usable id');
      } else if (typeof questions === 'string') {
        refuse('malformed question', questions);
      } else if (state.questions >= OUTBOX_LIMITS.questions) {
        refuse('too many questions', 'a run may ask only a few questions');
      } else {
        state.questions += 1;
        batch.questions.push({
          id,
          questions,
          ...(deadline && !Number.isNaN(deadline.getTime())
            ? { expiresAt: deadline }
            : {}),
        });
      }
      continue;
    }

    batch.rejected.push({ line, reason: 'unknown record' });
  }

  return batch;
}

function citationsOf(value: unknown): Array<{ path: string; lines?: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(
      (c): c is { path: string; lines?: unknown } =>
        !!c &&
        typeof c.path === 'string' &&
        c.path.length > 0 &&
        c.path.length <= 1000 &&
        // A repository path, not somewhere in the guest.
        !c.path.startsWith('/') &&
        !c.path.split('/').includes('..'),
    )
    .slice(0, OUTBOX_LIMITS.citations)
    .map((c) => ({
      path: c.path,
      ...(typeof c.lines === 'string' && /^\d{1,6}(-\d{1,6})?$/.test(c.lines)
        ? { lines: c.lines }
        : {}),
    }));
}

/**
 * The session an outbox belongs to, as far as applying it is concerned.
 *
 * Any channel can apply an outbox, so the checks do not depend on a run. A
 * hosted run is a session with `runId` set. A session that comes through a
 * connector or an inbox has no run. Where a run exists, what is written names
 * the run, exactly as it did before sessions existed.
 */
export interface OutboxSession {
  /** The session row. Absent for a hosted run that is known by its run. */
  sessionId?: string;
  issueId: string;
  workspaceId: string;
  /** The identity the writes carry. */
  actorUserId: string;
  /** Set when the session is a hosted run. */
  runId?: string;
  /** The person a question is for. */
  requesterId?: string | null;
  /** How long a question waits for a person. */
  questionWaitMs?: number;
}

/** The run an outbox belongs to, as far as applying it is concerned. */
export interface OutboxRun {
  id: string;
  issueId: string;
  workspaceId: string;
  agentUserId: string;
  /** The member who started the run. A question is for this person. */
  createdById?: string | null;
  /** The run's config, which can set how long a question waits. */
  config?: unknown;
}

/**
 * How long the run's questions wait for a person. A run sets it with
 * `limits.questionWaitMs`; thirty minutes when it does not.
 */
export function questionWaitMs(config: unknown): number {
  const ms = (config as { limits?: { questionWaitMs?: unknown } } | null)
    ?.limits?.questionWaitMs;

  return typeof ms === 'number' && Number.isInteger(ms) && ms > 0
    ? Math.min(ms, AGENT_QUESTION_MAX_WAIT_MS)
    : AGENT_QUESTION_DEFAULT_WAIT_MS;
}

/** A hosted run as an outbox session. */
export const sessionOfRun = (run: OutboxRun): OutboxSession => ({
  issueId: run.issueId,
  workspaceId: run.workspaceId,
  actorUserId: run.agentUserId,
  runId: run.id,
  requesterId: run.createdById ?? null,
  questionWaitMs: questionWaitMs(run.config),
});

/** The text of a question, without the secrets the guest could have seen. */
function scrubQuestions(
  questions: AgentQuestionItem[],
  scrub: (text: string) => string,
): AgentQuestionItem[] {
  return questions.map((item) => ({
    ...item,
    prompt: scrub(item.prompt),
    ...(item.options
      ? {
          options: item.options.map((option) => ({
            ...option,
            label: scrub(option.label),
            ...(option.description !== undefined
              ? { description: scrub(option.description) }
              : {}),
          })),
        }
      : {}),
  }));
}

const isRun = (who: OutboxRun | OutboxSession): who is OutboxRun =>
  'agentUserId' in who;

export interface OutboxResult {
  applied: string[];
  failed: string[];
  /** Questions that no person will see: the agent has to be told. */
  refusedQuestions?: Array<{ id: string; reason: string }>;
}

@Injectable()
export class RunOutboxService {
  private readonly logger = new Logger(RunOutboxService.name);

  constructor(
    private comments: IssueCommentsService,
    private entries: PageEntriesService,
    private checklist: ChecklistItemsService,
    private questions: AgentQuestionsService,
  ) {}

  /**
   * Posts the notes, proposes the facts and opens the questions of one batch.
   * Criteria wait for `tickCriteria`. Never throws: one write that fails is reported, and the
   * rest still go.
   *
   * `scrub` removes secrets the guest could have seen from anything posted.
   */
  async apply(
    who: OutboxRun | OutboxSession,
    batch: OutboxBatch,
    scope: string,
    scrub: (text: string) => string,
  ): Promise<OutboxResult> {
    const session = isRun(who) ? sessionOfRun(who) : who;
    const result: OutboxResult = {
      applied: [],
      failed: [],
      refusedQuestions: [...batch.refusedQuestions],
    };

    for (const note of batch.notes) {
      await this.attempt(result, 'note', () =>
        this.comments.createIssueComment(
          { issueId: session.issueId },
          session.actorUserId,
          {
            bodyMarkdown: scrub(note.body),
            sourceMetadata: session.runId
              ? { source: 'agent-run-note', agentRunId: session.runId }
              : {
                  source: 'agent-session-note',
                  agentSessionId: session.sessionId,
                },
          },
        ),
      );
    }

    for (const fact of batch.facts) {
      await this.attempt(result, 'fact', () =>
        this.entries.createEntry(
          null,
          { userId: session.actorUserId, tokenId: null },
          {
            content: scrub(fact.content),
            kind: fact.kind,
            scope,
            sourceSession: session.runId
              ? `agent-run:${session.runId}`
              : `agent-session:${session.sessionId}`,
            ...(fact.citations.length ? { citations: fact.citations } : {}),
          },
          session.workspaceId,
        ),
      );
    }

    for (const asked of batch.questions) {
      await this.attempt(result, 'question', async () => {
        try {
          if (!session.requesterId) {
            // Not the issue's assignee: the question is for whoever started
            // the run, and a run nobody started has nobody to ask.
            throw new RangeError('The run has no person to ask.');
          }

          await this.questions.create({
          workspaceId: session.workspaceId,
          issueId: session.issueId,
          agentRunId: session.runId ?? null,
          agentSessionId: session.sessionId ?? null,
          externalId: asked.id,
          source: 'tool',
          questions: scrubQuestions(asked.questions, scrub),
          assigneeId: session.requesterId,
          waitMs: session.questionWaitMs,
          ...(asked.expiresAt ? { agentDeadline: asked.expiresAt } : {}),
        });
        } catch (error) {
          result.refusedQuestions?.push({
            id: asked.id,
            reason:
              error instanceof RangeError
                ? error.message
                : 'Vantik could not store it',
          });
          throw error;
        }
      });
    }

    return result;
  }

  /** Ticks the criteria the agent claimed, once the session has succeeded. */
  async tickCriteria(
    who: OutboxRun | OutboxSession,
    state: OutboxState,
  ): Promise<OutboxResult> {
    const session = isRun(who) ? sessionOfRun(who) : who;
    const result: OutboxResult = { applied: [], failed: [] };

    for (const id of state.criteria.keys()) {
      await this.attempt(result, 'criterion', () =>
        this.checklist.updateChecklistItem(
          { checklistItemId: id },
          session.actorUserId,
          { completed: true },
        ),
      );
    }

    return result;
  }

  private async attempt(
    result: OutboxResult,
    what: string,
    write: () => Promise<unknown>,
  ) {
    try {
      await write();
      result.applied.push(what);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.failed.push(`${what}: ${message.slice(0, 200)}`);
      this.logger.warn({
        message: `Could not apply an agent's ${what}: ${message}`,
        where: 'RunOutboxService',
      });
    }
  }
}

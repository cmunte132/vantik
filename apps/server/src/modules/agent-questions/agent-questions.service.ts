import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AGENT_QUESTION_DEFAULT_WAIT_MS,
  AGENT_QUESTION_EXTERNAL_ID_PATTERN,
  AGENT_QUESTION_LIMITS,
  AGENT_QUESTION_MAX_WAIT_MS,
  type AgentQuestionItem,
  type AgentQuestionSource,
  parseAgentAnswers,
  parseAgentQuestions,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { LoggerService } from 'modules/logger/logger.service';

type QuestionRow = Prisma.AgentQuestionGetPayload<object>;

/**
 * What the agent-runs module gives this service, so this module does not
 * import it. The executors live there, and they import this module.
 */
export interface AgentQuestionHooks {
  /**
   * Hands the end of a question (an answer, or no answer) to the agent's
   * machine. Returns true when it got there.
   */
  deliver(question: QuestionRow): Promise<boolean>;
  /** Writes a line on the feed of the run that asked. */
  event(question: QuestionRow, message: string): Promise<void>;
}

export interface NewAgentQuestion {
  workspaceId: string;
  issueId: string;
  agentRunId?: string | null;
  agentSessionId?: string | null;
  /** The id that the guest gave the question. Unique per run. */
  externalId: string;
  source: AgentQuestionSource;
  questions: unknown;
  /** The person who started the run. */
  assigneeId: string;
  /** How long the question waits for a person. */
  waitMs?: number | null;
  /** The moment the agent stops waiting, by its own clock. Never extends. */
  agentDeadline?: Date | null;
}

export interface AnswerScope {
  workspaceId: string;
  userId: string;
}

/**
 * The questions that agents ask people.
 *
 * Every harness comes through here. The extension tool writes a line in the
 * outbox, the connector forwards an omp dialog, and both become the same row.
 * The agent wrote the question, so it is checked and cut to the limits before
 * it is stored.
 *
 * A question lives in one of four states. OPEN ends in ANSWERED when a person
 * answers, in EXPIRED when nobody does in time, and in CANCELLED when the run
 * ends first. The end of a question is handed to the agent's machine; the
 * hooks do that, and `deliveredAt` records that it arrived.
 */
@Injectable()
export class AgentQuestionsService {
  private readonly logger = new LoggerService('AgentQuestionsService');
  private hooks: AgentQuestionHooks | undefined;

  constructor(private readonly prisma: PrismaService) {}

  setHooks(hooks: AgentQuestionHooks): void {
    this.hooks = hooks;
  }

  /**
   * Opens a question. Idempotent on (run, externalId): a line of the outbox
   * that is read twice gives one row. Throws RangeError for a question that
   * cannot be used.
   */
  async create(input: NewAgentQuestion): Promise<QuestionRow> {
    const externalId = input.externalId.trim();

    if (!AGENT_QUESTION_EXTERNAL_ID_PATTERN.test(externalId)) {
      throw new RangeError('The question id must be a short plain token.');
    }

    const questions = parseAgentQuestions(input.questions);

    if (typeof questions === 'string') {
      throw new RangeError(questions);
    }

    if (input.agentRunId) {
      const existing = await this.prisma.agentQuestion.findFirst({
        where: { agentRunId: input.agentRunId, externalId },
      });

      if (existing) {
        return existing;
      }

      const asked = await this.prisma.agentQuestion.count({
        where: { agentRunId: input.agentRunId },
      });

      if (asked >= AGENT_QUESTION_LIMITS.perRun) {
        throw new RangeError(
          `A run may ask ${AGENT_QUESTION_LIMITS.perRun} questions.`,
        );
      }
    }

    const waitMs = Math.min(
      Math.max(input.waitMs ?? AGENT_QUESTION_DEFAULT_WAIT_MS, 1000),
      AGENT_QUESTION_MAX_WAIT_MS,
    );

    let question: QuestionRow;

    try {
      question = await this.prisma.agentQuestion.create({
        data: {
          workspaceId: input.workspaceId,
          issueId: input.issueId,
          agentRunId: input.agentRunId ?? null,
          agentSessionId: input.agentSessionId ?? null,
          externalId,
          source: input.source,
          questions: questions as unknown as Prisma.InputJsonValue,
          assigneeId: input.assigneeId,
          expiresAt: new Date(
            Math.min(
              Date.now() + waitMs,
              input.agentDeadline?.getTime() ?? Infinity,
            ),
          ),
        },
      });
    } catch (error) {
      // Two reads of the same line raced; the first one won.
      if (
        input.agentRunId &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.agentQuestion.findFirst({
          where: { agentRunId: input.agentRunId, externalId },
        });

        if (existing) {
          return existing;
        }
      }
      throw error;
    }

    await this.event(question, `Asked a person: ${summary(questions)}`);
    await this.notify(question);

    return question;
  }

  /**
   * Records a person's answer and hands it to the agent. Only an OPEN question
   * takes an answer; the first answer wins.
   */
  async answer(
    questionId: string,
    scope: AnswerScope,
    body: { answers: unknown },
  ): Promise<QuestionRow> {
    const question = await this.prisma.agentQuestion.findFirst({
      where: { id: questionId, workspaceId: scope.workspaceId, deleted: null },
    });

    if (!question) {
      throw new NotFoundException({
        message: `Agent question ${questionId} not found`,
      });
    }

    if (question.status === 'OPEN' && question.expiresAt <= new Date()) {
      await this.expireOne(question);
      throw new ConflictException({
        message: 'Nobody answered in time, so the agent went on alone.',
      });
    }

    if (question.status !== 'OPEN') {
      throw new ConflictException({
        message: `This question is ${question.status.toLowerCase()}.`,
      });
    }

    const answers = parseAgentAnswers(
      question.questions as unknown as AgentQuestionItem[],
      body.answers,
    );

    if (typeof answers === 'string') {
      throw new RangeError(answers);
    }

    const { count } = await this.prisma.agentQuestion.updateMany({
      where: { id: question.id, status: 'OPEN' },
      data: {
        status: 'ANSWERED',
        answers: answers as unknown as Prisma.InputJsonValue,
        answeredById: scope.userId,
        answeredAt: new Date(),
      },
    });

    if (count === 0) {
      throw new ConflictException({
        message: 'Somebody else answered this question first.',
      });
    }

    const answered = await this.prisma.agentQuestion.findUniqueOrThrow({
      where: { id: question.id },
    });
    const person = await this.prisma.user.findUnique({
      where: { id: scope.userId },
      select: { fullname: true },
    });

    await this.event(
      answered,
      `${person?.fullname ?? 'A person'} answered the question`,
    );
    await this.deliver(answered);

    return this.prisma.agentQuestion.findUniqueOrThrow({
      where: { id: question.id },
    });
  }

  /** Expires every open question whose time has passed. Returns how many. */
  async expireDue(now = new Date()): Promise<number> {
    const due = await this.prisma.agentQuestion.findMany({
      where: { status: 'OPEN', expiresAt: { lte: now } },
      take: 200,
    });
    let expired = 0;

    for (const question of due) {
      try {
        if (await this.expireOne(question)) {
          expired += 1;
        }
      } catch (error) {
        this.logger.error({
          message: `Could not expire agent question ${question.id}: ${error}`,
          where: 'AgentQuestionsService.expireDue',
          error: error instanceof Error ? error : undefined,
        });
      }
    }

    return expired;
  }

  /** The questions of a run whose end has not reached the agent yet. */
  undelivered(agentRunId: string): Promise<QuestionRow[]> {
    return this.prisma.agentQuestion.findMany({
      where: {
        agentRunId,
        status: { in: ['ANSWERED', 'EXPIRED'] },
        deliveredAt: null,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async markDelivered(questionId: string): Promise<void> {
    await this.prisma.agentQuestion.updateMany({
      where: { id: questionId, deliveredAt: null },
      data: { deliveredAt: new Date() },
    });
  }

  private async expireOne(question: QuestionRow): Promise<boolean> {
    const { count } = await this.prisma.agentQuestion.updateMany({
      where: { id: question.id, status: 'OPEN' },
      data: { status: 'EXPIRED' },
    });

    if (count === 0) {
      return false;
    }

    const expired = { ...question, status: 'EXPIRED' as const };

    await this.event(
      expired,
      'Nobody answered the question in time, so the agent went on alone',
    );
    await this.deliver(expired);

    return true;
  }

  /** Hands the end of a question to the agent. A failure is retried later. */
  private async deliver(question: QuestionRow): Promise<void> {
    if (!this.hooks || !question.agentRunId) {
      return;
    }

    try {
      if (await this.hooks.deliver(question)) {
        await this.markDelivered(question.id);
      }
    } catch (error) {
      this.logger.error({
        message: `Could not deliver agent question ${question.id}: ${error}`,
        where: 'AgentQuestionsService.deliver',
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Tells the person who started the run. This writes the notification row
   * directly: the delivery pipeline is built around issue events, and a
   * question is not one. A failure is logged and never refuses the question.
   */
  private async notify(question: QuestionRow): Promise<void> {
    try {
      const run = question.agentRunId
        ? await this.prisma.agentRun.findUnique({
            where: { id: question.agentRunId },
            select: { agentUserId: true },
          })
        : null;

      await this.prisma.notification.create({
        data: {
          type: 'AgentQuestionAsked',
          userId: question.assigneeId,
          issueId: question.issueId,
          createdById: run?.agentUserId ?? null,
          actionData: { agentQuestionId: question.id },
          workspaceId: question.workspaceId,
        },
      });
    } catch (error) {
      this.logger.error({
        message: `Could not notify about agent question ${question.id}: ${error}`,
        where: 'AgentQuestionsService.notify',
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  /** The feed is a record of the work, never a reason to refuse it. */
  private async event(question: QuestionRow, message: string): Promise<void> {
    if (!this.hooks || !question.agentRunId) {
      return;
    }

    try {
      await this.hooks.event(question, message);
    } catch {
      // The run may be over already.
    }
  }
}

/** The first prompt, short enough for a feed line. */
function summary(questions: AgentQuestionItem[]): string {
  const first = questions[0].prompt.replace(/\s+/g, ' ');
  const text = first.length > 160 ? `${first.slice(0, 157)}...` : first;

  return questions.length > 1
    ? `${text} (and ${questions.length - 1} more)`
    : text;
}

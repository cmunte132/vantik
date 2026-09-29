import { Injectable } from '@nestjs/common';
import { KnowledgeJobTrigger, Prisma } from '@prisma/client';
import { PrismaService } from 'nestjs-prisma';

import { LoggerService } from 'modules/logger/logger.service';

/** How long a job run is kept. */
export const JOB_RUN_RETENTION_DAYS = 30;

/** The jobs that the server queues when it starts. */
const BOOT_JOBS = ['indexConsolidatedEntries', 'recomputeEntryModules'];

/** What a Bull job gives the recorder. Only the parts it reads. */
export interface RecordedJob {
  name?: string;
  data?: unknown;
  attemptsMade?: number;
  opts?: { repeat?: unknown };
}

/** What a job run was about. */
export interface JobRunSubject {
  workspaceId?: string | null;
  /** The entry, run or page the job was about. */
  subjectId?: string | null;
  /** An entry id: the workspace is read from the entry. */
  entryId?: string | null;
  /** A run id: the workspace is read from the run. */
  agentRunId?: string | null;
}

/** What a job counted, by name. */
export type JobRunCounts = Record<string, number | string | boolean | null>;

/**
 * Records each run of a gardener job: what started it, when it started and
 * finished, what it counted, and its error when it failed.
 *
 * The recorder never fails a job. A job that cannot be recorded still runs,
 * and the error of a job that fails is recorded and then thrown again, so
 * that Bull still tries it again.
 */
@Injectable()
export default class KnowledgeJobRunsService {
  private readonly logger = new LoggerService('KnowledgeJobRunsService');

  constructor(private prisma: PrismaService) {}

  async record<T>(
    name: string,
    job: RecordedJob | undefined,
    subject: JobRunSubject,
    work: () => Promise<T>,
    counts?: (result: T) => JobRunCounts | undefined,
  ): Promise<T> {
    const started = new Date();
    const id = await this.start(name, job, subject, started);

    try {
      const result = await work();

      await this.finish(id, started, {
        counts: counts ? counts(result) : asCounts(result),
      });

      return result;
    } catch (error) {
      await this.finish(id, started, {
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  }

  /** Removes the job runs older than the retention window. */
  async prune(now: Date = new Date()): Promise<number> {
    const { count } = await this.prisma.knowledgeJobRun.deleteMany({
      where: {
        startedAt: {
          lt: new Date(now.getTime() - JOB_RUN_RETENTION_DAYS * 86_400_000),
        },
      },
    });

    return count;
  }

  private async start(
    name: string,
    job: RecordedJob | undefined,
    subject: JobRunSubject,
    startedAt: Date,
  ): Promise<string | null> {
    try {
      const workspaceId = await this.workspaceOf(subject);
      const row = await this.prisma.knowledgeJobRun.create({
        data: {
          job: name,
          trigger: triggerOf(name, job),
          workspaceId,
          subjectId:
            subject.subjectId ?? subject.entryId ?? subject.agentRunId ?? null,
          attempt: (job?.attemptsMade ?? 0) + 1,
          startedAt,
        },
        select: { id: true },
      });

      return row.id;
    } catch (error) {
      this.logger.warn({
        message: `The run of job ${name} was not recorded: ${error}`,
        where: 'KnowledgeJobRunsService.start',
      });

      return null;
    }
  }

  private async finish(
    id: string | null,
    started: Date,
    outcome: { counts?: JobRunCounts; error?: string },
  ): Promise<void> {
    if (!id) {
      return;
    }

    const finishedAt = new Date();

    try {
      await this.prisma.knowledgeJobRun.update({
        where: { id },
        data: {
          finishedAt,
          durationMs: finishedAt.getTime() - started.getTime(),
          counts: (outcome.counts ?? undefined) as
            | Prisma.InputJsonValue
            | undefined,
          error: outcome.error?.slice(0, 2000),
        },
      });
    } catch (error) {
      this.logger.warn({
        message: `The end of job run ${id} was not recorded: ${error}`,
        where: 'KnowledgeJobRunsService.finish',
      });
    }
  }

  private async workspaceOf(subject: JobRunSubject): Promise<string | null> {
    if (subject.workspaceId) {
      return subject.workspaceId;
    }

    if (subject.entryId) {
      const entry = await this.prisma.pageEntry.findUnique({
        where: { id: subject.entryId },
        select: { workspaceId: true },
      });

      return entry?.workspaceId ?? null;
    }

    if (subject.agentRunId) {
      const run = await this.prisma.agentRun.findUnique({
        where: { id: subject.agentRunId },
        select: { workspaceId: true },
      });

      return run?.workspaceId ?? null;
    }

    return null;
  }
}

/**
 * A repeatable job ran on its schedule. A job the server queues at start
 * with no workspace ran at boot. Any other job ran because something
 * happened.
 */
export function triggerOf(
  name: string,
  job: RecordedJob | undefined,
): KnowledgeJobTrigger {
  if (job?.opts?.repeat) {
    return KnowledgeJobTrigger.SCHEDULE;
  }

  const data = (job?.data ?? {}) as { workspaceId?: string };

  if (BOOT_JOBS.includes(name) && !data.workspaceId) {
    return KnowledgeJobTrigger.BOOT;
  }

  return KnowledgeJobTrigger.EVENT;
}

/** A job's result, when it is a flat record of what the job counted. */
function asCounts(result: unknown): JobRunCounts | undefined {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return undefined;
  }

  return Object.values(result).every(
    (value) =>
      value === null || ['number', 'string', 'boolean'].includes(typeof value),
  )
    ? (result as JobRunCounts)
    : undefined;
}

import { InjectQueue } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bull';
import { PrismaService } from 'nestjs-prisma';

import { LoggerService } from 'modules/logger/logger.service';

import {
  ACTIVITY_DEBOUNCE_MS,
  analysisEnabled,
  analysisIntervalMs,
  ANALYZE_TEAM_JOB,
  AnalyzeTeamJob,
  LOST_JOB_MS,
  TEAM_ANALYSIS_QUEUE,
} from './team-activity.interface';

const logger = new LoggerService('TeamActivityService');

/**
 * Tracks when a team is active, and schedules the stuck-issue analysis while
 * it is. The state lives in TeamDashboardSettings, so every replica agrees.
 */
@Injectable()
export class TeamActivityService {
  constructor(
    private prisma: PrismaService,
    @InjectQueue(TEAM_ANALYSIS_QUEUE) private queue: Queue<AnalyzeTeamJob>,
  ) {}

  /**
   * Notes that the team did something. It never throws: a failure here must
   * not fail the request that caused the activity.
   */
  async record(teamId: string): Promise<void> {
    if (!analysisEnabled()) {
      return;
    }
    try {
      await this.touch(teamId);
      await this.ensureScheduled(teamId);
    } catch (error) {
      logger.error({
        message: `Could not record activity for team ${teamId}: ${error}`,
        where: 'TeamActivityService.record',
        error: error instanceof Error ? error : undefined,
      });
    }
  }

  /** Sets lastActivityAt, at most once per debounce window. */
  private async touch(teamId: string) {
    const now = new Date();
    const stale = new Date(now.getTime() - ACTIVITY_DEBOUNCE_MS);

    const { count } = await this.prisma.teamDashboardSettings.updateMany({
      where: {
        teamId,
        OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: stale } }],
      },
      data: { lastActivityAt: now },
    });
    if (count > 0) {
      return;
    }

    // Either the write was debounced, or the row does not exist yet.
    const exists = await this.prisma.teamDashboardSettings.count({
      where: { teamId },
    });
    if (exists > 0) {
      return;
    }
    try {
      await this.prisma.teamDashboardSettings.create({
        data: { teamId, lastActivityAt: now },
      });
    } catch (error) {
      // A concurrent request made the row first. That request set the time.
      if ((error as { code?: string })?.code !== 'P2002') {
        throw error;
      }
    }
  }

  /**
   * Makes sure one analysis job is queued for the team. The conditional
   * update is the claim: only the caller that changes the row adds the job,
   * so replicas never queue two.
   */
  async ensureScheduled(teamId: string, retry = true): Promise<void> {
    if (!analysisEnabled()) {
      return;
    }

    const settings = await this.prisma.teamDashboardSettings.findUnique({
      where: { teamId },
      select: { lastAnalysisAt: true, nextAnalysisAt: true },
    });
    if (!settings) {
      return;
    }

    const now = Date.now();
    const earliest = settings.lastAnalysisAt
      ? settings.lastAnalysisAt.getTime() + analysisIntervalMs()
      : now;
    const next = new Date(Math.max(now, earliest));

    // The claim also needs lastAnalysisAt to be what we read. A run can end
    // between our read and our write, and next would then be wrong (now).
    const { count } = await this.prisma.teamDashboardSettings.updateMany({
      where: {
        teamId,
        lastAnalysisAt: settings.lastAnalysisAt,
        OR: [
          { nextAnalysisAt: null },
          { nextAnalysisAt: { lt: new Date(now - LOST_JOB_MS) } },
        ],
      },
      data: { nextAnalysisAt: next },
    });
    if (count !== 1) {
      if (retry) {
        const fresh = await this.prisma.teamDashboardSettings.findUnique({
          where: { teamId },
          select: { lastAnalysisAt: true },
        });
        if (
          fresh?.lastAnalysisAt?.getTime() !==
          settings.lastAnalysisAt?.getTime()
        ) {
          await this.ensureScheduled(teamId, false);
        }
      }
      return;
    }

    // A claim that was still set was a lost job. Remove it, in case the
    // queue still holds it and would promote it later.
    if (settings.nextAnalysisAt) {
      await this.removeOldJob(teamId, settings.nextAnalysisAt);
    }

    try {
      // The id carries the run time. Bull ignores an add whose id matches a
      // job that still exists, and that includes the job now running.
      await this.queue.add(
        ANALYZE_TEAM_JOB,
        { teamId, at: next.getTime() },
        {
          delay: Math.max(0, next.getTime() - now),
          jobId: jobIdFor(teamId, next),
          removeOnComplete: true,
          removeOnFail: 20,
          attempts: 1,
        },
      );
    } catch (error) {
      // Give the claim back, or the team stays unscheduled for an hour.
      await this.prisma.teamDashboardSettings.updateMany({
        where: { teamId, nextAnalysisAt: next },
        data: { nextAnalysisAt: null },
      });
      throw error;
    }
  }

  private async removeOldJob(teamId: string, at: Date) {
    try {
      const job = await this.queue.getJob(jobIdFor(teamId, at));
      await job?.remove();
    } catch {
      // Best effort. The processor skips a job that is no longer the claim.
    }
  }
}

function jobIdFor(teamId: string, at: Date): string {
  return `${ANALYZE_TEAM_JOB}:${teamId}:${at.getTime()}`;
}

/**
 * Records activity from a request path. It swallows every failure, including
 * a service that is missing, so the request goes on.
 */
export function noteActivity(
  activity: Pick<TeamActivityService, 'record'> | null | undefined,
  teamId: string | null | undefined,
): void {
  if (!activity || !teamId) {
    return;
  }
  const fail = (error: unknown) =>
    logger.error({
      message: `Could not record activity for team ${teamId}: ${error}`,
      where: 'noteActivity',
    });
  try {
    Promise.resolve(activity.record(teamId)).catch(fail);
  } catch (error) {
    fail(error);
  }
}

import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { PrismaService } from 'nestjs-prisma';

import { LoggerService } from 'modules/logger/logger.service';

import { StuckAnalysisService } from './stuck-analysis.service';
import {
  analysisEnabled,
  ANALYZE_TEAM_JOB,
  AnalyzeTeamJob,
  TEAM_ANALYSIS_QUEUE,
} from './team-activity.interface';
import { TeamActivityService } from './team-activity.service';

/**
 * Runs one analysis and decides whether another follows. The chain goes on
 * only while the team keeps working: a run that finds no activity since the
 * run before it ends the chain, and the next activity starts it again.
 */
@Processor(TEAM_ANALYSIS_QUEUE)
export class TeamAnalysisProcessor {
  private readonly logger: LoggerService = new LoggerService(
    'TeamAnalysisProcessor',
  );

  constructor(
    private prisma: PrismaService,
    private activity: TeamActivityService,
    private analysis: StuckAnalysisService,
  ) {}

  @Process(ANALYZE_TEAM_JOB)
  async handle(job: Job<AnalyzeTeamJob>) {
    await this.processTeam(job.data.teamId, job.data.at);
  }

  async processTeam(teamId: string, at?: number): Promise<void> {
    const settings = await this.prisma.teamDashboardSettings.findUnique({
      where: { teamId },
      select: { lastAnalysisAt: true, nextAnalysisAt: true },
    });
    if (!settings) {
      return;
    }
    // The claim moved on, so a newer job owns the chain. Do nothing.
    if (at !== undefined && settings.nextAnalysisAt?.getTime() !== at) {
      this.logger.info({
        message: `Skipped a superseded analysis job of team ${teamId}`,
        where: 'TeamAnalysisProcessor.processTeam',
      });
      return;
    }

    const previousRun = settings.lastAnalysisAt;
    const runStart = new Date();

    if (analysisEnabled()) {
      try {
        const result = await this.analysis.analyzeTeam(teamId);
        this.logger.info({
          message: `Analyzed ${result.analyzed} stuck issue(s) of team ${teamId}`,
          where: 'TeamAnalysisProcessor.processTeam',
        });
      } catch (error) {
        this.logger.error({
          message: `The stuck-issue analysis of team ${teamId} failed: ${error}`,
          where: 'TeamAnalysisProcessor.processTeam',
          error: error instanceof Error ? error : undefined,
        });
      }
    }

    // Clear the claim even after a failure, or the chain would stall until
    // the lost-job timeout.
    await this.prisma.teamDashboardSettings.update({
      where: { teamId },
      data: { lastAnalysisAt: runStart },
    });
    // Clear only our own claim, never a newer one.
    await this.prisma.teamDashboardSettings.updateMany({
      where: {
        teamId,
        ...(at === undefined ? {} : { nextAnalysisAt: new Date(at) }),
      },
      data: { nextAnalysisAt: null },
    });

    // Read after the clear, so activity during the run is not missed.
    const after = await this.prisma.teamDashboardSettings.findUnique({
      where: { teamId },
      select: { lastActivityAt: true },
    });
    const active =
      after?.lastActivityAt != null &&
      (previousRun == null || after.lastActivityAt > previousRun);
    if (active) {
      await this.activity.ensureScheduled(teamId);
    }
  }
}

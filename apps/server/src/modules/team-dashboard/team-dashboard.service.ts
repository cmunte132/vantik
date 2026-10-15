import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  StateThreshold,
  StuckIssue,
  TeamDashboardMetrics,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { LoggerService } from 'modules/logger/logger.service';

import {
  burndown,
  categoryMap,
  CycleEvent,
  CycleInfo,
  cycleTime,
  cycleVelocity,
  groupStints,
  IssueInfo,
  LearnedThreshold,
  learnThresholds,
  moveTime,
  resolveThresholds,
  selectStuck,
  StateInfo,
  StateMove,
  weeklyVelocity,
} from './team-dashboard.compute';

/** How long a team's metrics stay cached. */
export const METRICS_CACHE_MS = 60_000;

interface TeamData {
  states: StateInfo[];
  issues: IssueInfo[];
  moves: StateMove[];
}

@Injectable()
export class TeamDashboardService {
  private readonly logger: LoggerService = new LoggerService(
    'TeamDashboardService',
  );

  private readonly metricsCache = new Map<
    string,
    { expires: number; value: TeamDashboardMetrics }
  >();

  constructor(private prisma: PrismaService) {}

  /**
   * Loads what the computations need for one team. It reads the whole state
   * history of the team, because a stint needs the move that opened it, and
   * that move can be old. The metrics cache keeps the cost down.
   */
  private async loadTeamData(teamId: string): Promise<TeamData> {
    const [workflows, issues, history] = await Promise.all([
      this.prisma.workflow.findMany({
        where: { teamId, deleted: null },
        select: { id: true, name: true, category: true },
        orderBy: { position: 'asc' },
      }),
      this.prisma.issue.findMany({
        where: { teamId, deleted: null },
        select: {
          id: true,
          number: true,
          title: true,
          assigneeId: true,
          createdAt: true,
          estimate: true,
          stateId: true,
          stateEnteredAt: true,
          cycleId: true,
        },
      }),
      this.prisma.issueHistory.findMany({
        where: {
          deleted: null,
          toStateId: { not: null },
          issue: { teamId, deleted: null },
        },
        select: {
          issueId: true,
          createdAt: true,
          updatedAt: true,
          fromStateId: true,
          toStateId: true,
        },
      }),
    ]);

    return {
      states: workflows.map((workflow) => ({
        id: workflow.id,
        name: workflow.name,
        category: workflow.category,
      })),
      issues,
      moves: history.map((row) => ({
        issueId: row.issueId,
        at: moveTime(row),
        fromStateId: row.fromStateId,
        toStateId: row.toStateId,
      })),
    };
  }

  async getMetrics(teamId: string): Promise<TeamDashboardMetrics> {
    const cached = this.metricsCache.get(teamId);
    if (cached && cached.expires > Date.now()) {
      return cached.value;
    }

    const now = new Date();
    const data = await this.loadTeamData(teamId);
    const categoryOf = categoryMap(data.states);
    const stints = groupStints(data.issues, data.moves);

    const [team, cycles] = await Promise.all([
      this.prisma.team.findUnique({
        where: { id: teamId },
        select: { currentCycle: true },
      }),
      this.prisma.cycle.findMany({
        where: { teamId, deleted: null },
        select: {
          id: true,
          number: true,
          name: true,
          startDate: true,
          endDate: true,
          closedAt: true,
        },
      }),
    ]);

    const current: CycleInfo | undefined =
      team?.currentCycle == null
        ? undefined
        : cycles.find((cycle) => cycle.number === team.currentCycle);

    let burndownResult: TeamDashboardMetrics['burndown'] = null;
    if (current) {
      const events = await this.prisma.cycleHistory.findMany({
        where: { cycleId: current.id, deleted: null },
        select: { issueId: true, createdAt: true, changeType: true },
      });
      const cycleEvents: CycleEvent[] = events.map((event) => ({
        issueId: event.issueId,
        at: event.createdAt,
        changeType: event.changeType,
      }));
      const touched = new Set(cycleEvents.map((event) => event.issueId));
      const scoped = data.issues.filter(
        (issue) => issue.cycleId === current.id || touched.has(issue.id),
      );
      burndownResult = burndown(
        current,
        scoped,
        cycleEvents,
        stints,
        categoryOf,
        now,
      );
    }

    const value: TeamDashboardMetrics = {
      velocity: {
        weekly: weeklyVelocity(data.issues, stints, categoryOf, now),
        cycles: cycleVelocity(cycles, data.issues, categoryOf, now),
      },
      burndown: burndownResult,
      cycleTime: cycleTime(data.issues, stints, categoryOf, now),
    };
    this.metricsCache.set(teamId, {
      expires: Date.now() + METRICS_CACHE_MS,
      value,
    });
    return value;
  }

  /** Learns the thresholds for one team and stores them. */
  async recomputeLearned(
    teamId: string,
  ): Promise<Record<string, LearnedThreshold>> {
    const data = await this.loadTeamData(teamId);
    const learned = learnThresholds(
      data.states,
      groupStints(data.issues, data.moves),
      new Date(),
    );
    await this.prisma.teamDashboardSettings.upsert({
      where: { teamId },
      create: {
        teamId,
        learnedThresholds: learned as unknown as Prisma.InputJsonValue,
        learnedAt: new Date(),
      },
      update: {
        learnedThresholds: learned as unknown as Prisma.InputJsonValue,
        learnedAt: new Date(),
      },
    });
    return learned;
  }

  /** The nightly job: learns the thresholds of every live team. */
  async recomputeAll(): Promise<{ teams: number; failed: number }> {
    const teams = await this.prisma.team.findMany({
      where: { deleted: null },
      select: { id: true },
    });
    let failed = 0;
    for (const team of teams) {
      try {
        await this.recomputeLearned(team.id);
      } catch (error) {
        failed += 1;
        this.logger.error({
          message: `Could not learn the thresholds of team ${team.id}: ${error}`,
          where: 'TeamDashboardService.recomputeAll',
          error: error instanceof Error ? error : undefined,
        });
      }
    }
    return { teams: teams.length, failed };
  }

  private async settingsOf(teamId: string) {
    const settings = await this.prisma.teamDashboardSettings.findUnique({
      where: { teamId },
    });
    if (settings && settings.learnedAt) {
      return {
        learned: settings.learnedThresholds as unknown as Record<
          string,
          LearnedThreshold
        >,
        overrides: settings.thresholdOverrides as unknown as Record<
          string,
          number
        >,
      };
    }
    // Missing or never learned: compute now and keep the result.
    const learned = await this.recomputeLearned(teamId);
    return {
      learned,
      overrides: (settings?.thresholdOverrides ?? {}) as unknown as Record<
        string,
        number
      >,
    };
  }

  private async statesOf(teamId: string): Promise<StateInfo[]> {
    const workflows = await this.prisma.workflow.findMany({
      where: { teamId, deleted: null },
      select: { id: true, name: true, category: true },
      orderBy: { position: 'asc' },
    });
    return workflows;
  }

  async getThresholds(teamId: string): Promise<StateThreshold[]> {
    const [states, settings] = await Promise.all([
      this.statesOf(teamId),
      this.settingsOf(teamId),
    ]);
    return resolveThresholds(states, settings.learned, settings.overrides);
  }

  /** A number clears nothing and sets hours. Null clears the override. */
  async setOverrides(
    teamId: string,
    overrides: Record<string, number | null>,
  ): Promise<StateThreshold[]> {
    const states = await this.statesOf(teamId);
    const stateIds = new Set(states.map((state) => state.id));

    for (const [stateId, hours] of Object.entries(overrides)) {
      if (!stateIds.has(stateId)) {
        throw new BadRequestException(
          `State ${stateId} does not belong to this team`,
        );
      }
      if (
        hours !== null &&
        (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0)
      ) {
        throw new BadRequestException(
          `The override for state ${stateId} must be a number above 0, or null`,
        );
      }
    }

    const existing = await this.prisma.teamDashboardSettings.findUnique({
      where: { teamId },
      select: { thresholdOverrides: true },
    });
    const merged: Record<string, number> = {
      ...((existing?.thresholdOverrides ?? {}) as Record<string, number>),
    };
    for (const [stateId, hours] of Object.entries(overrides)) {
      if (hours === null) {
        delete merged[stateId];
      } else {
        merged[stateId] = hours;
      }
    }

    await this.prisma.teamDashboardSettings.upsert({
      where: { teamId },
      create: {
        teamId,
        thresholdOverrides: merged as Prisma.InputJsonValue,
      },
      update: { thresholdOverrides: merged as Prisma.InputJsonValue },
    });

    return await this.getThresholds(teamId);
  }

  async getStuck(teamId: string): Promise<StuckIssue[]> {
    const thresholds = await this.getThresholds(teamId);
    const startedIds = thresholds.map((threshold) => threshold.stateId);
    if (startedIds.length === 0) {
      return [];
    }
    const issues = await this.prisma.issue.findMany({
      where: { teamId, deleted: null, stateId: { in: startedIds } },
      select: {
        id: true,
        number: true,
        title: true,
        assigneeId: true,
        createdAt: true,
        estimate: true,
        stateId: true,
        stateEnteredAt: true,
        cycleId: true,
      },
    });
    return selectStuck(issues, thresholds, new Date());
  }
}

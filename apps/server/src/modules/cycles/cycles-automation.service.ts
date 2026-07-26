import { BadRequestException, Injectable } from '@nestjs/common';
import {
  Cycle,
  CyclesModeEnum,
  CycleStatusEnum,
  DEFAULT_CYCLES_FREQUENCY,
  DEFAULT_UPCOMING_CYCLES,
  TeamPreferenceDto,
  UnfinishedDestinationEnum,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { LoggerService } from 'modules/logger/logger.service';

import { CyclesService } from './cycles.service';

interface MaintenanceResult {
  teamsVisited: number;
  cyclesClosed: number;
  cyclesCreated: number;
}

/**
 * The automatic mode's machinery: a team configures a cadence once, presses
 * Start, and cycles keep rolling with no further ceremony.
 *
 * Everything here is scoped to teams in `auto` mode with the cadence running.
 * Manual teams are not merely skipped as an optimisation — their cycles are
 * theirs to open and close, and a schedule that completed one behind their back
 * would take a decision out of their hands mid-sprint.
 */
@Injectable()
export class CyclesAutomationService {
  private readonly logger: LoggerService = new LoggerService(
    'CyclesAutomationService',
  );

  constructor(
    private prisma: PrismaService,
    private cycles: CyclesService,
  ) {}

  /**
   * Seeds the first batch and marks the cadence running.
   *
   * Refuses when it is already running, so a double-clicked Start button cannot
   * produce two batches of cycles.
   */
  async startAutoCycles(teamId: string): Promise<Cycle[]> {
    const preferences = await this.getPreferences(teamId);

    if (preferences.cyclesAutoRunning) {
      throw new BadRequestException({
        message: 'Cycles are already running for this team',
      });
    }

    const cycles = await this.cycles.createCycles(teamId);

    await this.savePreferences(teamId, { cyclesAutoRunning: true });

    return cycles;
  }

  /**
   * Stops the cadence: no more cycles are created or closed automatically.
   *
   * Upcoming cycles are soft-deleted and their issues detached, because they
   * were only ever a plan the machine made. The current cycle is left to finish
   * — a team in the middle of one has work in flight — and completed cycles are
   * untouched history.
   */
  async stopAutoCycles(teamId: string): Promise<{ removed: number }> {
    const upcoming = await this.prisma.cycle.findMany({
      where: {
        teamId,
        status: CycleStatusEnum.UPCOMING,
        deleted: null,
      },
      select: { id: true },
    });

    const upcomingIds = upcoming.map((cycle) => cycle.id);

    await this.prisma.$transaction([
      this.prisma.issue.updateMany({
        where: { cycleId: { in: upcomingIds }, deleted: null },
        data: { cycleId: null },
      }),
      this.prisma.cycle.updateMany({
        where: { id: { in: upcomingIds } },
        data: { deleted: new Date() },
      }),
    ]);

    await this.savePreferences(teamId, { cyclesAutoRunning: false });

    return { removed: upcomingIds.length };
  }

  /**
   * One maintenance pass over every team running the automatic cadence.
   *
   * Per team the order is replenish, close, replenish. Closing a cycle promotes
   * its successor, so there has to be one before anything is closed — otherwise
   * a team that reached the end of its batch would be left pointing at nothing
   * until the following pass. The second top-up refills what the promotion just
   * consumed.
   */
  async runMaintenance(): Promise<MaintenanceResult> {
    const teams = await this.prisma.team.findMany({
      where: { deleted: null },
      select: { id: true, name: true, preferences: true },
    });

    const result: MaintenanceResult = {
      teamsVisited: 0,
      cyclesClosed: 0,
      cyclesCreated: 0,
    };

    for (const team of teams) {
      const preferences = (team.preferences ?? {}) as TeamPreferenceDto;

      if (!this.shouldAutomate(preferences)) {
        continue;
      }

      result.teamsVisited += 1;

      try {
        result.cyclesCreated += await this.replenishUpcoming(
          team.id,
          preferences,
        );
        result.cyclesClosed += await this.closeEndedCycles(
          team.id,
          preferences,
        );
        result.cyclesCreated += await this.replenishUpcoming(
          team.id,
          preferences,
        );
      } catch (error) {
        // One team's bad state must not stop every other team's cycles from
        // rolling. Said out loud, because a cadence that silently stopped is
        // how this feature rotted in the first place.
        this.logger.error({
          message: `Cycle maintenance failed for team ${team.name}: ${error}`,
          where: 'CyclesAutomationService.runMaintenance',
          error: error instanceof Error ? error : undefined,
        });
      }
    }

    return result;
  }

  /**
   * Completes every cycle whose end date has passed, rolling unfinished issues
   * per the team's configured destination.
   *
   * Oldest first, because a team whose schedule was down for a while has a
   * backlog of ended cycles and each completion decides where the next one
   * starts.
   */
  private async closeEndedCycles(
    teamId: string,
    preferences: TeamPreferenceDto,
  ): Promise<number> {
    const endedCycles = await this.prisma.cycle.findMany({
      where: {
        teamId,
        endDate: { lte: new Date() },
        status: { not: CycleStatusEnum.COMPLETED },
        deleted: null,
      },
      orderBy: { number: 'asc' },
      select: { id: true },
    });

    const destination =
      preferences.autoRolloverDestination ??
      UnfinishedDestinationEnum.NEXT_CYCLE;

    for (const cycle of endedCycles) {
      await this.cycles.completeCycle(cycle.id, {
        unfinishedDestination: destination,
      });
    }

    return endedCycles.length;
  }

  /**
   * Tops the team back up to its configured number of upcoming cycles.
   *
   * Dates continue seamlessly from the last cycle's end, at the configured
   * length — the same arithmetic the seeder uses. A cadence changed mid-flight
   * applies from here on; existing cycles are not re-dated, since a team
   * planning into next month's cycle should not find it moved underneath them.
   */
  private async replenishUpcoming(
    teamId: string,
    preferences: TeamPreferenceDto,
  ): Promise<number> {
    const desired = preferences.upcomingCycles || DEFAULT_UPCOMING_CYCLES;
    const cycleLength =
      (preferences.cyclesFrequency || DEFAULT_CYCLES_FREQUENCY) * 7;

    const upcomingCount = await this.prisma.cycle.count({
      where: { teamId, status: CycleStatusEnum.UPCOMING, deleted: null },
    });

    if (upcomingCount >= desired) {
      return 0;
    }

    const lastCycle = await this.prisma.cycle.findFirst({
      where: { teamId, deleted: null },
      orderBy: { number: 'desc' },
      select: { number: true, endDate: true },
    });

    // A running team always has at least one cycle. No cycle at all means the
    // preference is out of step with reality — re-seeding from today would be a
    // guess about when the team meant to start.
    if (!lastCycle) {
      return 0;
    }

    let nextNumber = lastCycle.number + 1;
    let startDate = new Date(lastCycle.endDate);

    const cyclesData = [];
    for (let i = upcomingCount; i < desired; i++) {
      const endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() + cycleLength);

      cyclesData.push({
        teamId,
        name: `Cycle ${nextNumber}`,
        number: nextNumber,
        startDate,
        endDate,
        status: CycleStatusEnum.UPCOMING,
        preferences: {},
      });

      nextNumber++;
      startDate = new Date(endDate);
    }

    await this.prisma.$transaction(
      cyclesData.map((cycle) => this.prisma.cycle.create({ data: cycle })),
    );

    return cyclesData.length;
  }

  private shouldAutomate(preferences: TeamPreferenceDto): boolean {
    return (
      Boolean(preferences.cyclesEnabled) &&
      preferences.cyclesMode === CyclesModeEnum.AUTO &&
      Boolean(preferences.cyclesAutoRunning)
    );
  }

  private async getPreferences(teamId: string): Promise<TeamPreferenceDto> {
    const team = await this.prisma.team.findUniqueOrThrow({
      where: { id: teamId },
      select: { preferences: true },
    });

    return (team.preferences ?? {}) as TeamPreferenceDto;
  }

  private async savePreferences(
    teamId: string,
    values: Partial<TeamPreferenceDto>,
  ) {
    const preferences = await this.getPreferences(teamId);

    await this.prisma.team.update({
      where: { id: teamId },
      data: { preferences: { ...preferences, ...values } },
    });
  }
}

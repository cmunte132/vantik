import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CycleHistoryChangeType, WorkflowCategory } from '@prisma/client';
import {
  CompleteCycleDto,
  CreateCycleDto,
  Cycle,
  CycleHistoryChangeEnum,
  CycleStatusEnum,
  TeamPreferenceDto,
  UnfinishedDestinationEnum,
  UpdateCycleDto,
  WorkflowCategoryEnum,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

/**
 * Workflow categories that mean an issue is done with, for the purpose of
 * deciding what a completing cycle leaves behind. Cancelled counts as finished:
 * the work is not coming back, and dragging it into the next cycle would make
 * every burndown carry issues nobody intends to do.
 */
const FINISHED_CATEGORIES = [
  WorkflowCategoryEnum.COMPLETED,
  WorkflowCategoryEnum.CANCELED,
] as unknown as WorkflowCategory[];

@Injectable()
export class CyclesService {
  constructor(private prisma: PrismaService) {}

  async createCycles(teamId: string): Promise<Cycle[]> {
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { preferences: true },
    });
    const preferences = team.preferences as TeamPreferenceDto;
    const cycleLength = (preferences.cyclesFrequency || 2) * 7;
    const numberOfCycles = preferences.upcomingCycles || 2;

    // Get the latest cycle number
    const latestCycle = await this.prisma.cycle.findFirst({
      where: { teamId },
      orderBy: { number: 'desc' },
      select: { number: true },
    });

    const firstCycleNumber = (latestCycle?.number ?? 0) + 1;
    let currentCycleNumber = firstCycleNumber;
    let currentStartDate = this.roundToNearest30Minutes(new Date());
    const cyclesData = [];

    // Create multiple cycles
    for (let i = 0; i < numberOfCycles + 1; i++) {
      const endDate = new Date(currentStartDate);
      endDate.setDate(endDate.getDate() + cycleLength);

      cyclesData.push({
        teamId,
        name: `Cycle ${currentCycleNumber}`,
        number: currentCycleNumber,
        startDate: currentStartDate,
        status: i === 0 ? CycleStatusEnum.CURRENT : CycleStatusEnum.UPCOMING,
        endDate,
        preferences: {},
      });

      // Prepare for next cycle
      currentCycleNumber++;
      currentStartDate = new Date(endDate);
    }

    // Create all cycles in a transaction
    const cycles = await this.prisma.$transaction(
      cyclesData.map((cycle) => this.prisma.cycle.create({ data: cycle })),
    );
    // The number of the batch's first cycle — the one created CURRENT — not a
    // hardcoded 1. A team that already ran cycles 1-12 continues at 13, and
    // pinning the pointer to 1 sent it at a cycle that had long since closed.
    await this.prisma.team.update({
      where: { id: teamId },
      data: { currentCycle: firstCycleNumber },
    });

    return cycles;
  }

  async updateCycleDates(
    cycleId: string,
    updateCycleDates: UpdateCycleDto,
  ): Promise<Cycle[]> {
    const {
      startDate: startDateStr,
      endDate: endDateStr,
      description,
    } = updateCycleDates;
    const startDate = startDateStr ? new Date(startDateStr) : undefined;
    const endDate = endDateStr ? new Date(endDateStr) : undefined;

    const originalCycle = await this.prisma.cycle.findUnique({
      where: { id: cycleId },
      select: { teamId: true, number: true, startDate: true, endDate: true },
    });

    // If endDate not provided or hasn't changed, just update the current cycle
    if (!endDate || endDate.getTime() === originalCycle.endDate.getTime()) {
      const cycle = await this.prisma.cycle.update({
        where: { id: cycleId },
        data: {
          ...(startDate && { startDate }),
          ...(endDate && { endDate }),
          description,
        },
      });
      return [cycle];
    }

    // Get subsequent cycles only if end date has changed
    const subsequentCycles = await this.prisma.cycle.findMany({
      where: {
        teamId: originalCycle.teamId,
        number: { gt: originalCycle.number },
      },
      orderBy: { number: 'asc' },
    });

    // Calculate the date difference
    const daysDifference = Math.floor(
      (endDate.getTime() - originalCycle.endDate.getTime()) /
        (1000 * 60 * 60 * 24),
    );

    // Update all cycles in a transaction
    return this.prisma.$transaction([
      // Update the current cycle
      this.prisma.cycle.update({
        where: { id: cycleId },
        data: {
          ...(startDate && { startDate }),
          ...(endDate && { endDate }),
          description,
        },
      }),
      // Update all subsequent cycles
      ...subsequentCycles.map((cycle) => {
        const newStartDate = new Date(cycle.startDate);
        newStartDate.setDate(newStartDate.getDate() + daysDifference);
        const newEndDate = new Date(cycle.endDate);
        newEndDate.setDate(newEndDate.getDate() + daysDifference);

        return this.prisma.cycle.update({
          where: { id: cycle.id },
          data: {
            startDate: newStartDate,
            endDate: newEndDate,
          },
        });
      }),
    ]);
  }

  /**
   * Creates one cycle, at the end of the team's existing sequence.
   *
   * The batch seeder above is the automatic mode's tool; this is the manual
   * mode's. It never touches the team pointer — a cycle created by hand is
   * UPCOMING until somebody starts it, and starting it is what moves the
   * pointer.
   */
  async createCycle(createCycleDto: CreateCycleDto): Promise<Cycle> {
    const { teamId, name, startDate, endDate, description } = createCycleDto;

    if (new Date(endDate) <= new Date(startDate)) {
      throw new BadRequestException({
        message: 'A cycle must end after it starts',
      });
    }

    const latestCycle = await this.prisma.cycle.findFirst({
      where: { teamId },
      orderBy: { number: 'desc' },
      select: { number: true },
    });

    return await this.prisma.cycle.create({
      data: {
        teamId,
        name,
        // Numbering continues past deleted cycles, which is why this does not
        // filter them out: reusing the number of a cycle somebody removed would
        // put two "Cycle 4"s in one team's history.
        number: (latestCycle?.number ?? 0) + 1,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        description,
        status: CycleStatusEnum.UPCOMING,
        preferences: {},
      },
    });
  }

  /**
   * Promotes an UPCOMING cycle to CURRENT and points the team at it.
   *
   * One CURRENT cycle per team is the invariant everything else assumes: the
   * team's `currentCycle` is a single number, and "the current cycle" is what
   * the sidebar, the issue dropdown and every report resolve through it. Two
   * would make that question have two answers.
   */
  async startCycle(cycleId: string): Promise<Cycle> {
    const cycle = await this.getCycleOrThrow(cycleId);

    if (cycle.status !== CycleStatusEnum.UPCOMING) {
      throw new BadRequestException({
        message: `Only an upcoming cycle can be started; ${cycle.name} is ${cycle.status.toLowerCase()}`,
      });
    }

    const currentCycle = await this.prisma.cycle.findFirst({
      where: {
        teamId: cycle.teamId,
        status: CycleStatusEnum.CURRENT,
        deleted: null,
      },
      select: { name: true },
    });

    if (currentCycle) {
      throw new BadRequestException({
        message: `${currentCycle.name} is still running. Complete it before starting another cycle.`,
      });
    }

    const [started] = await this.prisma.$transaction([
      this.prisma.cycle.update({
        where: { id: cycleId },
        data: { status: CycleStatusEnum.CURRENT },
      }),
      this.prisma.team.update({
        where: { id: cycle.teamId },
        data: { currentCycle: cycle.number },
      }),
    ]);

    return started;
  }

  /**
   * Completes a cycle and decides where its unfinished work goes.
   *
   * The one operation both modes need: the automatic schedule calls it with the
   * team's configured destination, the manual dialog with whatever the user
   * picked. Before it existed, a cycle ended and its unfinished issues stayed
   * pinned to it forever — visible in a completed cycle, absent from the next
   * one, and counted in neither team's plan.
   *
   * All of it in one transaction. A half-applied completion is a cycle marked
   * done whose issues are still in it, or issues moved out of a cycle that is
   * still open — both worse than the failure.
   */
  async completeCycle(
    cycleId: string,
    completeCycleDto: CompleteCycleDto,
    userId?: string,
  ): Promise<Cycle> {
    const { unfinishedDestination } = completeCycleDto;
    const cycle = await this.getCycleOrThrow(cycleId);

    if (cycle.status === CycleStatusEnum.COMPLETED) {
      throw new BadRequestException({
        message: `${cycle.name} is already complete`,
      });
    }

    // Upcoming only. Without the status filter this found whatever sat at the
    // next number, and the promotion below would set a cycle that had already
    // been completed back to CURRENT — closedAt still populated — and roll this
    // cycle's leftovers into a sprint that had already reported as finished.
    const nextCycle = await this.prisma.cycle.findFirst({
      where: {
        teamId: cycle.teamId,
        number: cycle.number + 1,
        status: CycleStatusEnum.UPCOMING,
        deleted: null,
      },
      select: { id: true, number: true },
    });

    if (
      unfinishedDestination === UnfinishedDestinationEnum.NEXT_CYCLE &&
      !nextCycle
    ) {
      throw new BadRequestException({
        message:
          'There is no next cycle to move unfinished issues into. Create one first, or send them to the backlog.',
      });
    }

    // Resolved in two steps because `Issue.stateId` carries no relation to
    // Workflow, so there is nothing to filter through. Which states count as
    // finished is a per-team decision recorded in the workflow's category, not
    // a property of the issue.
    const finishedStates = await this.prisma.workflow.findMany({
      where: {
        teamId: cycle.teamId,
        deleted: null,
        category: { in: FINISHED_CATEGORIES },
      },
      select: { id: true },
    });

    const unfinishedIssues = await this.prisma.issue.findMany({
      where: {
        cycleId,
        deleted: null,
        stateId: { notIn: finishedStates.map((state) => state.id) },
      },
      select: { id: true, stateId: true, estimate: true },
    });

    const destinationCycleId =
      unfinishedDestination === UnfinishedDestinationEnum.NEXT_CYCLE
        ? nextCycle.id
        : null;

    // Only the cycle a team is actually running owns the team pointer. A cycle
    // completed out of turn — an upcoming one the schedule found past its end
    // date, or one closed straight through the API — must leave the running
    // cycle and the pointer where they are. Moving them regardless is how
    // completing a trailing upcoming cycle used to null `currentCycle` out from
    // under a sprint that was still in progress, and promote a successor into a
    // second CURRENT cycle beside it.
    const wasCurrent = cycle.status === CycleStatusEnum.CURRENT;
    const successor = wasCurrent ? nextCycle : null;

    await this.prisma.$transaction([
      this.prisma.cycle.update({
        where: { id: cycleId },
        data: {
          status: CycleStatusEnum.COMPLETED,
          closedAt: new Date(),
        },
      }),

      // Batched rather than one statement per issue: a cycle carrying a few
      // hundred unfinished issues produced 2n+3 statements in a single
      // interactive transaction and blew through Prisma's 5s default, so the
      // completion rolled back and the cycle could never be closed.
      ...(unfinishedIssues.length
        ? [
            this.prisma.issue.updateMany({
              where: { id: { in: unfinishedIssues.map((issue) => issue.id) } },
              data: { cycleId: destinationCycleId },
            }),
            // Written against the cycle the issue is leaving, so a burnup of
            // that cycle can still say what happened to the work it did not
            // finish. Without this the issues simply vanish from its history.
            this.prisma.cycleHistory.createMany({
              data: unfinishedIssues.map((issue) => ({
                cycleId,
                issueId: issue.id,
                userId,
                changeType: (destinationCycleId
                  ? CycleHistoryChangeEnum.MOVED
                  : CycleHistoryChangeEnum.REMOVED) as CycleHistoryChangeType,
                fromStateId: issue.stateId,
                toStateId: issue.stateId,
                fromEstimate: issue.estimate,
                toEstimate: issue.estimate,
              })),
            }),
          ]
        : []),

      // Promoting the next cycle here is what makes completion a single step
      // for the caller: the manual dialog and the schedule both end with a team
      // whose pointer is on a cycle that exists, or on nothing at all.
      ...(successor
        ? [
            this.prisma.cycle.update({
              where: { id: successor.id },
              data: { status: CycleStatusEnum.CURRENT },
            }),
          ]
        : []),

      ...(wasCurrent
        ? [
            this.prisma.team.update({
              where: { id: cycle.teamId },
              data: { currentCycle: successor ? successor.number : null },
            }),
          ]
        : []),
    ]);

    return await this.prisma.cycle.findUnique({ where: { id: cycleId } });
  }

  /**
   * Soft-deletes an UPCOMING cycle and detaches its issues.
   *
   * Upcoming only. A cycle that has run is a record of what a team did, and
   * deleting it would take its history and its issues' membership with it;
   * a cycle that has not started yet is only a plan.
   */
  async deleteCycle(cycleId: string): Promise<Cycle> {
    const cycle = await this.getCycleOrThrow(cycleId);

    if (cycle.status !== CycleStatusEnum.UPCOMING) {
      throw new BadRequestException({
        message: `Only an upcoming cycle can be deleted; ${cycle.name} is ${cycle.status.toLowerCase()}`,
      });
    }

    const [, deletedCycle] = await this.prisma.$transaction([
      // Detached rather than deleted: the issues themselves are nobody's idea
      // of disposable, they simply stop belonging to a cycle.
      this.prisma.issue.updateMany({
        where: { cycleId, deleted: null },
        data: { cycleId: null },
      }),
      this.prisma.cycle.update({
        where: { id: cycleId },
        data: { deleted: new Date() },
      }),
    ]);

    return deletedCycle;
  }

  private async getCycleOrThrow(cycleId: string) {
    const cycle = await this.prisma.cycle.findFirst({
      where: { id: cycleId, deleted: null },
    });

    if (!cycle) {
      throw new NotFoundException({ message: `Cycle ${cycleId} not found` });
    }

    return cycle;
  }

  roundToNearest30Minutes(date: Date): Date {
    const roundedDate = new Date(date);
    roundedDate.setMinutes(Math.ceil(roundedDate.getMinutes() / 30) * 30);
    roundedDate.setSeconds(0);
    roundedDate.setMilliseconds(0);
    return roundedDate;
  }
}

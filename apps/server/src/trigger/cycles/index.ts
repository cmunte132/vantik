import { PrismaClient } from '@prisma/client';
import { logger, schedules } from '@trigger.dev/sdk/v3';
import { CycleStatusEnum } from '@vantikhq/types';

interface Payload {
  type: 'DECLARATIVE' | 'IMPERATIVE';
  timestamp: Date;
  timezone: string;
  scheduleId: string;
  upcoming: Date[];
  lastTimestamp?: Date;
  externalId?: string;
}

const prisma = new PrismaClient();

/**
 * Whether the schedule may close this team's cycles behind its back.
 *
 * A stub with one caller and one answer today, kept because the per-team
 * `cyclesMode` preference lands next: manual-mode teams start and complete
 * their own cycles, and a cron that closed them anyway would take the decision
 * out of the user's hands mid-sprint. Reading `preferences` here is what makes
 * that a one-line change rather than a re-shaping of the job.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function shouldAutoClose(_preferences: Record<string, unknown>): boolean {
  return true;
}

export const closeCyclesSchedule = schedules.task({
  id: 'close-cycles',
  run: async (payload: Payload) => {
    logger.info(`Starting cycle closure check at ${payload.timestamp}`);

    try {
      // Only cycles still open. Without the status filter the query kept
      // returning every cycle that had ever ended, so each run re-closed the
      // whole history and re-wrote the team pointer from the oldest one.
      const endedCycles = await prisma.cycle.findMany({
        where: {
          endDate: { lte: new Date() },
          status: { not: CycleStatusEnum.COMPLETED },
          deleted: null,
        },
        // Oldest first: a team with a backlog of ended cycles has to be walked
        // in order, or the pointer lands on whichever one the database
        // happened to return last.
        orderBy: [{ teamId: 'asc' }, { number: 'asc' }],
        include: { team: true },
      });

      if (endedCycles.length === 0) {
        logger.info('No cycles to close');
        return {};
      }

      logger.info(`Found ${endedCycles.length} cycles to close`);

      let closed = 0;

      for (const endCycle of endedCycles) {
        if (
          !shouldAutoClose(
            (endCycle.team.preferences ?? {}) as Record<string, unknown>,
          )
        ) {
          continue;
        }

        // The cycle the team moves on to. Nothing else in the system promotes
        // an UPCOMING cycle, so without this the team pointed at a cycle that
        // stayed UPCOMING forever and no cycle was ever CURRENT again.
        const nextCycle = await prisma.cycle.findFirst({
          where: {
            teamId: endCycle.teamId,
            number: endCycle.number + 1,
            deleted: null,
          },
          select: { id: true, number: true },
        });

        await prisma.$transaction([
          prisma.cycle.update({
            where: { id: endCycle.id },
            data: {
              status: CycleStatusEnum.COMPLETED,
              closedAt: new Date(),
            },
          }),
          ...(nextCycle
            ? [
                prisma.cycle.update({
                  where: { id: nextCycle.id },
                  data: { status: CycleStatusEnum.CURRENT },
                }),
              ]
            : []),
          prisma.team.update({
            where: { id: endCycle.teamId },
            // Null, not `number + 1`, when the batch is exhausted. A number
            // with no cycle behind it is what every reader of this field
            // treats as "the current cycle", so the team's current-cycle view
            // silently emptied instead of saying there was none.
            data: { currentCycle: nextCycle ? nextCycle.number : null },
          }),
        ]);

        closed += 1;
      }

      logger.info(`Successfully closed ${closed} cycles`);

      return { closed };
    } catch (error) {
      logger.error('Error in cycle closure schedule', { error });
      throw error;
    }
  },
});

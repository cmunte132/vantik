import { CycleHistoryChangeType, Prisma } from '@prisma/client';

interface CycleChangedIssue {
  id: string;
  stateId: string;
  estimate: number | null;
}

/**
 * The CycleHistory rows for an issue that changes cycle.
 *
 * The old cycle gets MOVED when the issue goes to another cycle, and REMOVED
 * when it goes to none. This matches CyclesService.completeCycle. The new
 * cycle gets ADDED. The burndown reads these rows to rebuild scope over time.
 */
export function cycleChangeRows(
  issue: CycleChangedIssue,
  fromCycleId: string | null,
  toCycleId: string | null,
  userId: string | null,
): Prisma.CycleHistoryCreateManyInput[] {
  if (fromCycleId === toCycleId) {
    return [];
  }
  const base = {
    issueId: issue.id,
    userId,
    fromStateId: issue.stateId,
    toStateId: issue.stateId,
    fromEstimate: issue.estimate,
    toEstimate: issue.estimate,
  };
  const rows: Prisma.CycleHistoryCreateManyInput[] = [];
  if (fromCycleId) {
    rows.push({
      ...base,
      cycleId: fromCycleId,
      changeType: (toCycleId
        ? 'MOVED'
        : 'REMOVED') as unknown as CycleHistoryChangeType,
    });
  }
  if (toCycleId) {
    rows.push({
      ...base,
      cycleId: toCycleId,
      changeType: 'ADDED' as unknown as CycleHistoryChangeType,
    });
  }
  return rows;
}

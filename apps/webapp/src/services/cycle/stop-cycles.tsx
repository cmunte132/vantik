import { ajaxPost, mutationHook } from 'services/utils';

/**
 * Stops the automatic cadence. Upcoming cycles are removed and their issues
 * detached; the running cycle is left to finish.
 */
export function stopCycles({
  teamId,
}: {
  teamId: string;
}): Promise<{ removed: number }> {
  return ajaxPost({ url: '/api/v1/cycles/stop', data: { teamId } });
}

export const useStopCyclesMutation = mutationHook(stopCycles);

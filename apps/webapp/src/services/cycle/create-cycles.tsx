import type { CycleType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

/**
 * Seeds a batch of cycles from the team's configured cadence — the automatic
 * mode's Start button. Distinct from `createCycle`, which makes exactly one.
 */
export function createCycles({
  teamId,
}: {
  teamId: string;
}): Promise<CycleType[]> {
  return ajaxPost({ url: '/api/v1/cycles', data: { teamId } });
}

export const useCreateCyclesMutation = mutationHook(createCycles);

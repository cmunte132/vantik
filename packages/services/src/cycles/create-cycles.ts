import type { Cycle } from '@vantikhq/types';

import axios from 'axios';

/**
 * Seeds a batch of cycles from the team's configured cadence — the automatic
 * mode's Start button. Distinct from `createCycle`, which makes exactly one.
 */
export async function createCycles({
  teamId,
}: {
  teamId: string;
}): Promise<Cycle[]> {
  const response = await axios.post('/api/v1/cycles', { teamId });

  return response.data;
}

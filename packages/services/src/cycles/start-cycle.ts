import type { Cycle } from '@vantikhq/types';

import axios from 'axios';

export async function startCycle({
  cycleId,
}: {
  cycleId: string;
}): Promise<Cycle> {
  const response = await axios.post(`/api/v1/cycles/${cycleId}/start`);

  return response.data;
}

import type { Cycle } from '@vantikhq/types';

import axios from 'axios';

export async function deleteCycle({
  cycleId,
}: {
  cycleId: string;
}): Promise<Cycle> {
  const response = await axios.delete(`/api/v1/cycles/${cycleId}`);

  return response.data;
}

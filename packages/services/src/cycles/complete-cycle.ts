import type { CompleteCycleDto, Cycle } from '@vantikhq/types';

import axios from 'axios';

interface CompleteCycleDtoWithCycleId extends CompleteCycleDto {
  cycleId: string;
}

export async function completeCycle({
  cycleId,
  ...completeCycleDto
}: CompleteCycleDtoWithCycleId): Promise<Cycle> {
  const response = await axios.post(
    `/api/v1/cycles/${cycleId}/complete`,
    completeCycleDto,
  );

  return response.data;
}

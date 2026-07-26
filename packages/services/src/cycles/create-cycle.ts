import type { CreateCycleDto, Cycle } from '@vantikhq/types';

import axios from 'axios';

export async function createCycle(
  createCycleDto: CreateCycleDto,
): Promise<Cycle> {
  const response = await axios.post('/api/v1/cycles/single', createCycleDto);

  return response.data;
}

import { Pat } from '@vantikhq/types';
import axios from 'axios';

export async function getPats(): Promise<Pat[]> {
  const response = await axios.get(`/api/v1/users/pats`);

  return response.data;
}

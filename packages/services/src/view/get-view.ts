import { GetViewRequestIdDTO, View } from '@vantikhq/types';
import axios from 'axios';

export async function getView({ viewId }: GetViewRequestIdDTO): Promise<View> {
  const response = await axios.get(`/api/v1/views/${viewId}`);

  return response.data;
}

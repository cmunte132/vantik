import type { Template, TemplateIdDto } from '@vantikhq/types';

import axios from 'axios';

export async function deleteTemplate({
  templateId,
}: TemplateIdDto): Promise<Template> {
  const response = await axios.delete(`/api/v1/templates/${templateId}`);

  return response.data;
}

import type { Template, TemplateIdDto } from '@vantikhq/types';

import { ajaxDelete, mutationHook } from 'services/utils';

export function deleteTemplate({
  templateId,
}: TemplateIdDto): Promise<Template> {
  return ajaxDelete({ url: `/api/v1/templates/${templateId}` });
}

export const useDeleteTemplateMutation = mutationHook(deleteTemplate);

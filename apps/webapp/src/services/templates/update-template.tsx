import type { Template, UpdateTemplateDto } from '@vantikhq/types';

import { ajaxPost, mutationHook } from 'services/utils';

interface UpdateTemplateDtoWithId extends UpdateTemplateDto {
  templateId: string;
}

export function updateTemplate({
  templateId,
  ...data
}: UpdateTemplateDtoWithId): Promise<Template> {
  return ajaxPost({ url: `/api/v1/templates/${templateId}`, data });
}

export const useUpdateTemplateMutation = mutationHook(updateTemplate);

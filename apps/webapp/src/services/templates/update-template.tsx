import type { UpdateTemplateDto } from '@vantikhq/types';

import type { TemplateType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

interface UpdateTemplateDtoWithId extends UpdateTemplateDto {
  templateId: string;
}

export function updateTemplate({
  templateId,
  ...data
}: UpdateTemplateDtoWithId): Promise<TemplateType> {
  return ajaxPost({ url: `/api/v1/templates/${templateId}`, data });
}

export const useUpdateTemplateMutation = mutationHook(updateTemplate);

import type { CreateTemplateDto } from '@vantikhq/types';

import type { TemplateType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

export function createTemplate(data: CreateTemplateDto): Promise<TemplateType> {
  return ajaxPost({ url: `/api/v1/templates`, data });
}

export const useCreateTemplateMutation = mutationHook(createTemplate);

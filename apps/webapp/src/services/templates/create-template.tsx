import type { CreateTemplateDto, Template } from '@vantikhq/types';

import { ajaxPost, mutationHook } from 'services/utils';

export function createTemplate(data: CreateTemplateDto): Promise<Template> {
  return ajaxPost({ url: `/api/v1/templates`, data });
}

export const useCreateTemplateMutation = mutationHook(createTemplate);

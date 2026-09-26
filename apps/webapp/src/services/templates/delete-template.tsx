import type { TemplateIdDto } from '@vantikhq/types';

import type { TemplateType } from 'common/types';

import { ajaxDelete, mutationHook } from 'services/utils';

export function deleteTemplate({
  templateId,
}: TemplateIdDto): Promise<TemplateType> {
  return ajaxDelete({ url: `/api/v1/templates/${templateId}` });
}

export const useDeleteTemplateMutation = mutationHook(deleteTemplate);

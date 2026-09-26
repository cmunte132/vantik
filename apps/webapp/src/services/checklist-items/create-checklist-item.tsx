import type { ChecklistItemType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

export interface CreateChecklistItemParams {
  issueId: string;
  body: string;
  sortOrder?: number;
}

export function createChecklistItem({
  issueId,
  body,
  sortOrder,
}: CreateChecklistItemParams): Promise<ChecklistItemType> {
  return ajaxPost({
    url: `/api/v1/checklist_items?issueId=${issueId}`,
    data: { body, sortOrder },
  });
}

export const useCreateChecklistItemMutation = mutationHook(createChecklistItem);

import type { ChecklistItemType } from 'common/types';

import { ajaxPost, mutationHook } from 'services/utils';

export interface UpdateChecklistItemParams {
  checklistItemId: string;
  body?: string;
  completed?: boolean;
  sortOrder?: number;
}

export function updateChecklistItem({
  checklistItemId,
  body,
  completed,
  sortOrder,
}: UpdateChecklistItemParams): Promise<ChecklistItemType> {
  return ajaxPost({
    url: `/api/v1/checklist_items/${checklistItemId}`,
    data: { body, completed, sortOrder },
  });
}

export const useUpdateChecklistItemMutation = mutationHook(updateChecklistItem);

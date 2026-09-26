import { ajaxDelete, mutationHook } from 'services/utils';

export interface DeleteChecklistItemParams {
  checklistItemId: string;
}

export function deleteChecklistItem({
  checklistItemId,
}: DeleteChecklistItemParams) {
  return ajaxDelete({
    url: `/api/v1/checklist_items/${checklistItemId}`,
  });
}

export const useDeleteChecklistItemMutation = mutationHook(deleteChecklistItem);

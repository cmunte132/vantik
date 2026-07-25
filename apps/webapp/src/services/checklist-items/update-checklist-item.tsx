import { useMutation } from '@tanstack/react-query';

import type { ChecklistItemType } from 'common/types';

import { ajaxPost } from 'services/utils';

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
}: UpdateChecklistItemParams) {
  return ajaxPost({
    url: `/api/v1/checklist_items/${checklistItemId}`,
    data: { body, completed, sortOrder },
  });
}

interface MutationParams {
  onMutate?: () => void;
  onSuccess?: (data: ChecklistItemType) => void;
  onError?: (error: string) => void;
}

export function useUpdateChecklistItemMutation({
  onMutate,
  onSuccess,
  onError,
}: MutationParams) {
  const onMutationTriggered = () => {
    onMutate && onMutate();
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onMutationError = (errorResponse: any) => {
    const errorText = errorResponse?.errors?.message || 'Error occured';

    onError && onError(errorText);
  };

  const onMutationSuccess = (data: ChecklistItemType) => {
    onSuccess && onSuccess(data);
  };

  return useMutation({
    mutationFn: updateChecklistItem,
    onError: onMutationError,
    onMutate: onMutationTriggered,
    onSuccess: onMutationSuccess,
  });
}

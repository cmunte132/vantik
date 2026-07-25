import { useMutation } from '@tanstack/react-query';

import { ajaxDelete } from 'services/utils';

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

interface MutationParams {
  onMutate?: () => void;
  onSuccess?: () => void;
  onError?: (error: string) => void;
}

export function useDeleteChecklistItemMutation({
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

  const onMutationSuccess = () => {
    onSuccess && onSuccess();
  };

  return useMutation({
    mutationFn: deleteChecklistItem,
    onError: onMutationError,
    onMutate: onMutationTriggered,
    onSuccess: onMutationSuccess,
  });
}

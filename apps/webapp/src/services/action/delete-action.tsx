import { deleteAction } from '@vantikhq/services';
import { useMutation } from '@tanstack/react-query';

import type { ActionType } from 'common/types';

interface MutationParams {
  onMutate?: () => void;
  onSuccess?: (data: ActionType) => void;
  onError?: (error: string) => void;
}

export function useDeleteActionMutation({
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

  const onMutationSuccess = (data: ActionType) => {
    onSuccess && onSuccess(data);
  };

  return useMutation({
    mutationFn: deleteAction,
    onError: onMutationError,
    onMutate: onMutationTriggered,
    onSuccess: onMutationSuccess
  });
}

import type { Cycle } from '@vantikhq/types';

import { useMutation } from '@tanstack/react-query';
import { updateCycle } from '@vantikhq/services';

interface MutationParams {
  onMutate?: () => void;
  onSuccess?: (data: Cycle) => void;
  onError?: (error: string) => void;
}

export function useUpdateCycleMutation({
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

  const onMutationSuccess = (data: Cycle) => {
    onSuccess && onSuccess(data);
  };

  return useMutation({
    mutationFn: updateCycle,
    onError: onMutationError,
    onMutate: onMutationTriggered,
    onSuccess: onMutationSuccess,
  });
}

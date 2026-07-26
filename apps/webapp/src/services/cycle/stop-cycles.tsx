import { useMutation } from '@tanstack/react-query';
import { stopCycles } from '@vantikhq/services';

interface MutationParams {
  onMutate?: () => void;
  onSuccess?: (data: { removed: number }) => void;
  onError?: (error: string) => void;
}

export function useStopCyclesMutation({
  onMutate,
  onSuccess,
  onError,
}: MutationParams) {
  const onMutationTriggered = () => {
    onMutate && onMutate();
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onMutationError = (errorResponse: any) => {
    const errorText =
      errorResponse?.response?.data?.message ||
      errorResponse?.errors?.message ||
      'Error occurred';

    onError && onError(errorText);
  };

  const onMutationSuccess = (data: { removed: number }) => {
    onSuccess && onSuccess(data);
  };

  return useMutation({
    mutationFn: stopCycles,
    onError: onMutationError,
    onMutate: onMutationTriggered,
    onSuccess: onMutationSuccess,
  });
}

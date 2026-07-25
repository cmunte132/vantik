import { useMutation, useQueryClient } from '@tanstack/react-query';
import { revokeAgent } from '@vantikhq/services';

import { GetAgents } from './get-agents';

interface MutationParams {
  onMutate?: () => void;
  onSuccess?: () => void;
  onError?: (error: string) => void;
}

export function useRevokeAgentMutation({
  onMutate,
  onSuccess,
  onError,
}: MutationParams) {
  const queryClient = useQueryClient();

  const onMutationTriggered = () => {
    onMutate && onMutate();
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onMutationError = (errorResponse: any) => {
    const errorText = errorResponse?.errors?.message || 'Error occurred';

    onError && onError(errorText);
  };

  const onMutationSuccess = () => {
    queryClient.invalidateQueries({ queryKey: [GetAgents] });
    onSuccess && onSuccess();
  };

  return useMutation({
    mutationFn: revokeAgent,
    onError: onMutationError,
    onMutate: onMutationTriggered,
    onSuccess: onMutationSuccess,
  });
}

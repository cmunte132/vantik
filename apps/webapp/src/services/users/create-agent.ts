import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createAgent } from '@vantikhq/services';
import { type AgentAccount } from '@vantikhq/types';

import { GetAgents } from './get-agents';

interface MutationParams {
  onMutate?: () => void;
  onSuccess?: (data: AgentAccount) => void;
  onError?: (error: string) => void;
}

export function useCreateAgentMutation({
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

  const onMutationSuccess = (data: AgentAccount) => {
    queryClient.invalidateQueries({ queryKey: [GetAgents] });
    onSuccess && onSuccess(data);
  };

  return useMutation({
    mutationFn: createAgent,
    onError: onMutationError,
    onMutate: onMutationTriggered,
    onSuccess: onMutationSuccess,
  });
}

import { useMutation } from '@tanstack/react-query';
import { connectIntegration, updateTeamMappings } from '@vantikhq/services';

interface MutationParams {
  onSuccess?: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onError?: (error: any) => void;
}

export function useConnectIntegrationMutation({
  onSuccess,
  onError,
}: MutationParams = {}) {
  return useMutation({
    mutationFn: connectIntegration,
    onSuccess: () => onSuccess && onSuccess(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onError: (error: any) => onError && onError(error),
  });
}

export function useUpdateTeamMappingsMutation({
  onSuccess,
  onError,
}: MutationParams = {}) {
  return useMutation({
    mutationFn: updateTeamMappings,
    onSuccess: () => onSuccess && onSuccess(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onError: (error: any) => onError && onError(error),
  });
}

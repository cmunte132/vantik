import { useMutation, useQueryClient } from '@tanstack/react-query';

import { ajaxPost } from 'services/utils';

import { GetAgents } from './get-agents';

interface MutationParams {
  onSuccess?: (result: { hidden: number }) => void;
  onError?: (error: string) => void;
}

/**
 * Clears revoked agents out of the listing.
 *
 * Hides rather than deletes, and that distinction is the whole reason this is
 * safe to offer: these accounts authored issues and comments, so removing the
 * user would break attribution on records that still name them. A revoked agent
 * cannot authenticate, so the row is all there is left to remove.
 */
export function useClearRevokedAgentsMutation({
  onSuccess,
  onError,
}: MutationParams = {}) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ workspaceId }: { workspaceId: string }) =>
      ajaxPost({
        url: `/api/v1/users/agents/clear_revoked?workspaceId=${workspaceId}`,
        data: {},
      }) as Promise<{ hidden: number }>,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: [GetAgents] });
      onSuccess?.(result);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onError: (error: any) =>
      onError?.(
        error?.response?.data?.message ??
          error?.errors?.message ??
          'Could not clear the revoked agents.',
      ),
  });
}

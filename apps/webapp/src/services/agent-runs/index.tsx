/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMutation, useQuery } from '@tanstack/react-query';

import { ajaxGet, ajaxPost } from 'services/utils';

export interface DelegateParams {
  issueId: string;
  agentUserId?: string;
  executor?: string;
  force?: boolean;
}

export function useDelegateMutation(options: {
  onSuccess?: (data: any) => void;
  onError?: (error: string) => void;
}) {
  return useMutation({
    mutationFn: (params: DelegateParams) =>
      ajaxPost({ url: '/api/v1/agent_runs', data: params }),
    onSuccess: options.onSuccess,
    onError: (error: any) =>
      // The server's refusals are written to be read as-is — "this issue
      // already has a run in progress", "too little description to delegate" —
      // so they are surfaced verbatim rather than replaced with a generic
      // failure message.
      options.onError?.(
        error?.response?.data?.message ??
          error?.message ??
          'Could not delegate this issue.',
      ),
  });
}

export function useCancelRunMutation(options: { onSuccess?: () => void } = {}) {
  return useMutation({
    mutationFn: ({ runId, reason }: { runId: string; reason?: string }) =>
      ajaxPost({ url: `/api/v1/agent_runs/${runId}/cancel`, data: { reason } }),
    onSuccess: options.onSuccess,
  });
}

export function useRetryRunMutation(options: { onSuccess?: () => void } = {}) {
  return useMutation({
    mutationFn: ({ runId }: { runId: string }) =>
      ajaxPost({ url: `/api/v1/agent_runs/${runId}/retry`, data: {} }),
    onSuccess: options.onSuccess,
  });
}

/**
 * Which backends this deployment can run work on, and whether each is usable.
 *
 * Fetched rather than assumed, because "hosted execution is unavailable and
 * here is why" is the difference between a disabled button someone reports as
 * a bug and one they can act on.
 */
export function useExecutors() {
  return useQuery({
    queryKey: ['agent-run-executors'],
    queryFn: () => ajaxGet({ url: '/api/v1/agent_runs/meta/executors' }),
    staleTime: 5 * 60 * 1000,
  });
}

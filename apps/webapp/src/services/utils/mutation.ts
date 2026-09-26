import { useMutation, useQueryClient } from '@tanstack/react-query';

/**
 * What a screen hands a mutation hook.
 *
 * `onError` receives words to show a person, never the raw error: a screen
 * that renders what it is given should not have to know which HTTP client
 * produced the failure, or where that client keeps the server's reason.
 */
export interface MutationCallbacks<TData = unknown, TVariables = unknown> {
  onMutate?: () => void;
  onSuccess?: (data: TData, variables: TVariables) => void;
  onError?: (message: string) => void;
}

export interface MutationOptions {
  /** Query keys whose answers this write makes stale. */
  invalidates?: string[];
  /** What to say when the server gives no reason of its own. */
  fallback?: string;
}

const NO_REASON = 'The request failed, and the server gave no reason.';

/**
 * The server's own words where it has any.
 *
 * The ajax client keeps a JSON error body under `errors`, and Nest puts its
 * reason in that body's `message` — a list when validation rejects more than
 * one field. A body that is not JSON arrives as `message` text, and a proxy's
 * error page is HTML: that is not a sentence anyone should be shown. An Error
 * thrown before any request is made has a `message` too.
 */
export function errorMessage(error: unknown, fallback = NO_REASON): string {
  const failure = error as {
    errors?: { message?: unknown };
    message?: unknown;
  };

  const candidates = [failure?.errors?.message, failure?.message];

  for (const candidate of candidates) {
    const text = Array.isArray(candidate)
      ? candidate.filter((part) => typeof part === 'string').join('; ')
      : candidate;

    if (
      typeof text === 'string' &&
      text.trim() &&
      !text.trim().startsWith('<')
    ) {
      return text.trim();
    }
  }

  return fallback;
}

export function useApiMutation<TData, TVariables>(
  mutationFn: (variables: TVariables) => Promise<TData>,
  { onMutate, onSuccess, onError }: MutationCallbacks<TData, TVariables> = {},
  { invalidates = [], fallback }: MutationOptions = {},
) {
  const queryClient = useQueryClient();

  return useMutation<TData, unknown, TVariables>({
    mutationFn,
    onMutate: () => {
      onMutate?.();
    },
    onSuccess: (data, variables) => {
      for (const key of invalidates) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }

      onSuccess?.(data, variables);
    },
    onError: (error) => onError?.(errorMessage(error, fallback)),
  });
}

/** A mutation hook for one API call, for the common case with nothing else to do. */
export function mutationHook<TData, TVariables>(
  mutationFn: (variables: TVariables) => Promise<TData>,
  options?: MutationOptions,
) {
  return function useBoundMutation(
    callbacks: MutationCallbacks<TData, TVariables> = {},
  ) {
    return useApiMutation(mutationFn, callbacks, options);
  };
}

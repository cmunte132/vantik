import { useMutation } from '@tanstack/react-query';
import {
  acceptModuleSuggestion,
  createCapability,
  createModule,
  createModuleRepo,
  createProduct,
  deleteCapability,
  deleteModule,
  deleteModuleRepo,
  deleteProduct,
  dismissModuleSuggestion,
  updateCapability,
  updateModule,
  updateModuleRepo,
  updateProduct,
} from '@vantikhq/services';

/**
 * The write side of the product axis.
 *
 * No optimistic update and no local write: every one of these rows comes back
 * over the socket as a sync action, and the store applies it there. Writing it
 * twice is how the two copies drift.
 */
interface MutationParams<T> {
  onMutate?: () => void;
  onSuccess?: (data: T) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onError?: (error: any) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mutation<TData, TVariables>(
  fn: (variables: TVariables) => Promise<TData>,
) {
  return ({ onMutate, onSuccess, onError }: MutationParams<TData> = {}) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useMutation({
      mutationFn: fn,
      onMutate: () => onMutate && onMutate(),
      onSuccess: (data: TData) => onSuccess && onSuccess(data),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onError: (error: any) => onError && onError(error),
    });
}

export const useCreateProductMutation = mutation(createProduct);
export const useUpdateProductMutation = mutation(updateProduct);
export const useDeleteProductMutation = mutation(deleteProduct);

export const useCreateModuleMutation = mutation(createModule);
export const useUpdateModuleMutation = mutation(updateModule);
export const useDeleteModuleMutation = mutation(deleteModule);

export const useCreateCapabilityMutation = mutation(createCapability);
export const useUpdateCapabilityMutation = mutation(updateCapability);
export const useDeleteCapabilityMutation = mutation(deleteCapability);

// The classifier proposes modules and a person answers. Accepting writes the
// issue, dismissing writes only the suggestion; both come back over the socket.
export const useAcceptModuleSuggestionMutation = mutation(
  acceptModuleSuggestion,
);
export const useDismissModuleSuggestionMutation = mutation(
  dismissModuleSuggestion,
);

// A module's repositories are not replicated, so the caller refetches after a
// write rather than waiting for a socket message that never comes.
export const useCreateModuleRepoMutation = mutation(createModuleRepo);
export const useUpdateModuleRepoMutation = mutation(updateModuleRepo);
export const useDeleteModuleRepoMutation = mutation(deleteModuleRepo);

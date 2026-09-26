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

import { mutationHook } from 'services/utils';

/**
 * The write side of the product axis.
 *
 * No optimistic update and no local write: every one of these rows comes back
 * over the socket as a sync action, and the store applies it there. Writing it
 * twice is how the two copies drift.
 */
export const useCreateProductMutation = mutationHook(createProduct);
export const useUpdateProductMutation = mutationHook(updateProduct);
export const useDeleteProductMutation = mutationHook(deleteProduct);

export const useCreateModuleMutation = mutationHook(createModule);
export const useUpdateModuleMutation = mutationHook(updateModule);
export const useDeleteModuleMutation = mutationHook(deleteModule);

export const useCreateCapabilityMutation = mutationHook(createCapability);
export const useUpdateCapabilityMutation = mutationHook(updateCapability);
export const useDeleteCapabilityMutation = mutationHook(deleteCapability);

// The classifier proposes modules and a person answers. Accepting writes the
// issue, dismissing writes only the suggestion; both come back over the socket.
export const useAcceptModuleSuggestionMutation = mutationHook(
  acceptModuleSuggestion,
);
export const useDismissModuleSuggestionMutation = mutationHook(
  dismissModuleSuggestion,
);

// A module's repositories are not replicated, so the caller refetches after a
// write rather than waiting for a socket message that never comes.
export const useCreateModuleRepoMutation = mutationHook(createModuleRepo);
export const useUpdateModuleRepoMutation = mutationHook(updateModuleRepo);
export const useDeleteModuleRepoMutation = mutationHook(deleteModuleRepo);

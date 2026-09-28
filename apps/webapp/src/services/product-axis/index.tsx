import type {
  CreateCapabilityDto,
  CreateModuleDto,
  CreateModuleRepoDto,
  CreateProductDto,
  ModuleRepo,
  RepositoryFolder,
  UpdateCapabilityDto,
  UpdateModuleDto,
  UpdateModuleRepoDto,
  UpdateProductDto,
} from '@vantikhq/types';

import { type UseQueryResult, useQuery } from '@tanstack/react-query';

import type { CapabilityType, ModuleType, ProductType } from 'common/types';

import {
  ajaxDelete,
  ajaxGet,
  ajaxPost,
  mutationHook,
  type XHRErrorResponse,
} from 'services/utils';

export function createProduct(
  createProductDto: CreateProductDto,
): Promise<ProductType> {
  return ajaxPost({ url: `/api/v1/products`, data: createProductDto });
}

export function updateProduct({
  productId,
  ...updateProductDto
}: UpdateProductDto & { productId: string }): Promise<ProductType> {
  return ajaxPost({
    url: `/api/v1/products/${productId}`,
    data: updateProductDto,
  });
}

export function deleteProduct({
  productId,
}: {
  productId: string;
}): Promise<ProductType> {
  return ajaxDelete({ url: `/api/v1/products/${productId}` });
}

/**
 * The modules as the API stores them, which is more than the synced model
 * carries: `verification` is read only by the page that edits it, so it is
 * fetched here rather than replicated to every client.
 */
export function getModules(): Promise<
  Array<ModuleType & { verification?: unknown }>
> {
  return ajaxGet({ url: `/api/v1/modules` });
}

export function createModule(
  createModuleDto: CreateModuleDto,
): Promise<ModuleType> {
  return ajaxPost({ url: `/api/v1/modules`, data: createModuleDto });
}

export function updateModule({
  moduleId,
  ...updateModuleDto
}: UpdateModuleDto & { moduleId: string }): Promise<ModuleType> {
  return ajaxPost({
    url: `/api/v1/modules/${moduleId}`,
    data: updateModuleDto,
  });
}

export function deleteModule({
  moduleId,
}: {
  moduleId: string;
}): Promise<ModuleType> {
  return ajaxDelete({ url: `/api/v1/modules/${moduleId}` });
}

/**
 * The repositories of a module.
 *
 * These rows are not replicated, so there is no store to read them from and
 * every screen that shows them asks for them.
 */
export function getModuleRepos({
  moduleId,
}: {
  moduleId: string;
}): Promise<ModuleRepo[]> {
  return ajaxGet({ url: `/api/v1/modules/${moduleId}/repos` });
}

export function createModuleRepo({
  moduleId,
  ...createModuleRepoDto
}: CreateModuleRepoDto & { moduleId: string }): Promise<ModuleRepo> {
  return ajaxPost({
    url: `/api/v1/modules/${moduleId}/repos`,
    data: createModuleRepoDto,
  });
}

export function updateModuleRepo({
  moduleId,
  moduleRepoId,
  ...updateModuleRepoDto
}: UpdateModuleRepoDto & {
  moduleId: string;
  moduleRepoId: string;
}): Promise<ModuleRepo> {
  return ajaxPost({
    url: `/api/v1/modules/${moduleId}/repos/${moduleRepoId}`,
    data: updateModuleRepoDto,
  });
}

/**
 * The folders of a linked repository that a module can claim.
 *
 * The server reads them from its own copy of the repository, so a repository
 * from any source offers them. The answer describes the repository, and every
 * module that links it shares it.
 */
export function getModuleRepoFolders({
  moduleId,
  moduleRepoId,
}: {
  moduleId: string;
  moduleRepoId: string;
}): Promise<RepositoryFolder[]> {
  return ajaxGet({
    url: `/api/v1/modules/${moduleId}/repos/${moduleRepoId}/folders`,
  });
}

export const GetModuleRepoFolders = 'getModuleRepoFolders';

/** Asked for only when somebody opens the picker. */
export function useGetModuleRepoFolders(
  moduleId: string,
  moduleRepoId: string,
  enabled: boolean,
): UseQueryResult<RepositoryFolder[], XHRErrorResponse> {
  return useQuery({
    queryKey: [GetModuleRepoFolders, moduleId, moduleRepoId],
    queryFn: () => getModuleRepoFolders({ moduleId, moduleRepoId }),
    enabled,
    retry: 1,
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });
}

export function deleteModuleRepo({
  moduleId,
  moduleRepoId,
}: {
  moduleId: string;
  moduleRepoId: string;
}): Promise<ModuleRepo> {
  return ajaxDelete({
    url: `/api/v1/modules/${moduleId}/repos/${moduleRepoId}`,
  });
}

export function createCapability(
  createCapabilityDto: CreateCapabilityDto,
): Promise<CapabilityType> {
  return ajaxPost({ url: `/api/v1/capabilities`, data: createCapabilityDto });
}

export function updateCapability({
  capabilityId,
  ...updateCapabilityDto
}: UpdateCapabilityDto & { capabilityId: string }): Promise<CapabilityType> {
  return ajaxPost({
    url: `/api/v1/capabilities/${capabilityId}`,
    data: updateCapabilityDto,
  });
}

export function deleteCapability({
  capabilityId,
}: {
  capabilityId: string;
}): Promise<CapabilityType> {
  return ajaxDelete({ url: `/api/v1/capabilities/${capabilityId}` });
}

/**
 * Promotes a module the classifier suggested to a module of the issue.
 *
 * Accepting is what moves a module from the least confident tier to the most
 * confident one. The issue comes back over the socket, so nothing is written
 * to the store here.
 */
export function acceptModuleSuggestion({
  issueId,
  moduleId,
}: {
  issueId: string;
  moduleId: string;
}) {
  return ajaxPost({
    url: `/api/v1/issues/ai/suggestions/${issueId}/modules/${moduleId}/accept`,
  });
}

/** Removes a suggested module, and remembers not to suggest it again. */
export function dismissModuleSuggestion({
  issueId,
  moduleId,
}: {
  issueId: string;
  moduleId: string;
}) {
  return ajaxPost({
    url: `/api/v1/issues/ai/suggestions/${issueId}/modules/${moduleId}/dismiss`,
  });
}

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

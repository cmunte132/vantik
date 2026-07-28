import type {
  Capability,
  CreateCapabilityDto,
  CreateModuleDto,
  CreateModuleRepoDto,
  CreateProductDto,
  Module,
  ModuleRepo,
  Product,
  UpdateCapabilityDto,
  UpdateModuleDto,
  UpdateModuleRepoDto,
  UpdateProductDto,
} from '@vantikhq/types';

import axios from 'axios';

export async function getProducts(): Promise<Product[]> {
  const response = await axios.get(`/api/v1/products`);

  return response.data;
}

export async function createProduct(
  createProductDto: CreateProductDto,
): Promise<Product> {
  const response = await axios.post(`/api/v1/products`, createProductDto);

  return response.data;
}

export async function updateProduct({
  productId,
  ...updateProductDto
}: UpdateProductDto & { productId: string }): Promise<Product> {
  const response = await axios.post(
    `/api/v1/products/${productId}`,
    updateProductDto,
  );

  return response.data;
}

export async function deleteProduct({
  productId,
}: {
  productId: string;
}): Promise<Product> {
  const response = await axios.delete(`/api/v1/products/${productId}`);

  return response.data;
}

export async function getModules(): Promise<Module[]> {
  const response = await axios.get(`/api/v1/modules`);

  return response.data;
}

export async function createModule(
  createModuleDto: CreateModuleDto,
): Promise<Module> {
  const response = await axios.post(`/api/v1/modules`, createModuleDto);

  return response.data;
}

export async function updateModule({
  moduleId,
  ...updateModuleDto
}: UpdateModuleDto & { moduleId: string }): Promise<Module> {
  const response = await axios.post(
    `/api/v1/modules/${moduleId}`,
    updateModuleDto,
  );

  return response.data;
}

export async function deleteModule({
  moduleId,
}: {
  moduleId: string;
}): Promise<Module> {
  const response = await axios.delete(`/api/v1/modules/${moduleId}`);

  return response.data;
}

/**
 * The repositories of a module.
 *
 * These rows are not replicated, so there is no store to read them from and
 * every screen that shows them asks for them.
 */
export async function getModuleRepos({
  moduleId,
}: {
  moduleId: string;
}): Promise<ModuleRepo[]> {
  const response = await axios.get(`/api/v1/modules/${moduleId}/repos`);

  return response.data;
}

export async function createModuleRepo({
  moduleId,
  ...createModuleRepoDto
}: CreateModuleRepoDto & { moduleId: string }): Promise<ModuleRepo> {
  const response = await axios.post(
    `/api/v1/modules/${moduleId}/repos`,
    createModuleRepoDto,
  );

  return response.data;
}

export async function updateModuleRepo({
  moduleId,
  moduleRepoId,
  ...updateModuleRepoDto
}: UpdateModuleRepoDto & {
  moduleId: string;
  moduleRepoId: string;
}): Promise<ModuleRepo> {
  const response = await axios.post(
    `/api/v1/modules/${moduleId}/repos/${moduleRepoId}`,
    updateModuleRepoDto,
  );

  return response.data;
}

export async function deleteModuleRepo({
  moduleId,
  moduleRepoId,
}: {
  moduleId: string;
  moduleRepoId: string;
}): Promise<ModuleRepo> {
  const response = await axios.delete(
    `/api/v1/modules/${moduleId}/repos/${moduleRepoId}`,
  );

  return response.data;
}

export async function getCapabilities(): Promise<Capability[]> {
  const response = await axios.get(`/api/v1/capabilities`);

  return response.data;
}

export async function createCapability(
  createCapabilityDto: CreateCapabilityDto,
): Promise<Capability> {
  const response = await axios.post(
    `/api/v1/capabilities`,
    createCapabilityDto,
  );

  return response.data;
}

export async function updateCapability({
  capabilityId,
  ...updateCapabilityDto
}: UpdateCapabilityDto & { capabilityId: string }): Promise<Capability> {
  const response = await axios.post(
    `/api/v1/capabilities/${capabilityId}`,
    updateCapabilityDto,
  );

  return response.data;
}

export async function deleteCapability({
  capabilityId,
}: {
  capabilityId: string;
}): Promise<Capability> {
  const response = await axios.delete(`/api/v1/capabilities/${capabilityId}`);

  return response.data;
}

/**
 * Promotes a module the classifier suggested to a module of the issue.
 *
 * Accepting is what moves a module from the least confident tier to the most
 * confident one. The issue comes back over the socket, so nothing is written
 * to the store here.
 */
export async function acceptModuleSuggestion({
  issueId,
  moduleId,
}: {
  issueId: string;
  moduleId: string;
}) {
  const response = await axios.post(
    `/api/v1/issues/ai/suggestions/${issueId}/modules/${moduleId}/accept`,
  );

  return response.data;
}

/** Removes a suggested module, and remembers not to suggest it again. */
export async function dismissModuleSuggestion({
  issueId,
  moduleId,
}: {
  issueId: string;
  moduleId: string;
}) {
  const response = await axios.post(
    `/api/v1/issues/ai/suggestions/${issueId}/modules/${moduleId}/dismiss`,
  );

  return response.data;
}

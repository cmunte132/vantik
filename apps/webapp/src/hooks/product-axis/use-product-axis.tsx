import { useRouter } from 'next/router';

import type { CapabilityType, ModuleType, ProductType } from 'common/types';

import { useContextStore } from 'store/global-context-provider';

/**
 * The product, module or capability named in the current route.
 *
 * A product and a module are addressed by their key rather than their id, so
 * that a URL stays readable and survives a rename of the display name. A
 * capability has no key: its name is unique in the workspace and its id is what
 * the route carries.
 */
export const useProduct = (): ProductType | undefined => {
  const {
    query: { productKey },
  } = useRouter();
  const { productsStore } = useContextStore();

  return productsStore.getProductWithKey(productKey as string);
};

export const useProductModule = (): ModuleType | undefined => {
  const {
    query: { moduleKey },
  } = useRouter();
  const { modulesStore } = useContextStore();

  return modulesStore.getModules.find(
    (module: ModuleType) => module.key === moduleKey,
  );
};

export const useCapability = (): CapabilityType | undefined => {
  const {
    query: { capabilityId },
  } = useRouter();
  const { capabilitiesStore } = useContextStore();

  return capabilitiesStore.getCapabilityWithId(capabilityId as string);
};

/**
 * The modules a product touches: the ones it owns, then the ones it borrows.
 *
 * Both belong in a product's issue view. A product is responsible for what it
 * owns, and its work still lands in the code it borrows.
 */
export const useProductModules = (productId?: string): ModuleType[] => {
  const { modulesStore } = useContextStore();

  if (!productId) {
    return [];
  }

  return [
    ...modulesStore.getModulesOwnedByProduct(productId),
    ...modulesStore.getModulesLinkedToProduct(productId),
  ];
};

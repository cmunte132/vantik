import type { ModuleType } from 'common/types';

/** What a product-axis screen is about. */
export type KnowledgeTarget =
  | { type: 'PRODUCT'; id: string }
  | { type: 'MODULE'; id: string }
  | { type: 'CAPABILITY'; id: string; moduleIds: string[] };

/**
 * The modules whose knowledge a product, module or capability screen shows.
 *
 * Knowledge entries resolve to modules, not to products or capabilities, so
 * each screen asks for the modules it stands for: a module for itself, a
 * capability for the modules that hold its code, and a product for the modules
 * it owns. Not the modules merely linked to a product — a design system linked
 * to three products would otherwise fill all three screens with its knowledge.
 */
export function knowledgeModuleIds(
  target: KnowledgeTarget,
  modules: Array<Pick<ModuleType, 'id' | 'ownerProductId'>>,
): string[] {
  if (target.type === 'MODULE') {
    return [target.id];
  }

  if (target.type === 'CAPABILITY') {
    return [...new Set(target.moduleIds)];
  }

  return modules
    .filter((productModule) => productModule.ownerProductId === target.id)
    .map((productModule) => productModule.id);
}

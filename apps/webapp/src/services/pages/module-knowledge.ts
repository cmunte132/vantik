/**
 * The most standing entries a product, module or capability screen lists.
 *
 * A product's screen asks for every module it owns, so without a cap one screen
 * would fetch the whole bank's knowledge about a large product.
 */
export const MODULE_KNOWLEDGE_LIMIT = 50;

/**
 * The request behind a product-axis screen's standing facts.
 *
 * Standing only: the section is headed "Standing facts", and an agent's
 * proposed or disputed claim shown there would read as knowledge the workspace
 * accepted. Newest first, capped at `MODULE_KNOWLEDGE_LIMIT`.
 */
export function moduleKnowledgeUrl(moduleIds: string[]): string {
  const params = new URLSearchParams({
    status: 'STANDING',
    moduleIds: [...moduleIds].sort().join(','),
    limit: String(MODULE_KNOWLEDGE_LIMIT),
  });

  return `/api/v1/page_entries?${params}`;
}

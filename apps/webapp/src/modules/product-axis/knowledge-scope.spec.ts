import { describe, expect, it } from 'vitest';

import { linkRoute } from 'modules/pages/link-route';

import { knowledgeModuleIds } from './knowledge-scope';

const modules = [
  { id: 'server', ownerProductId: 'cloud' },
  { id: 'webapp', ownerProductId: 'cloud' },
  { id: 'design-system', ownerProductId: null },
  { id: 'billing', ownerProductId: 'payments' },
];

describe('knowledgeModuleIds', () => {
  it("[KG-1.6] shows a module's own knowledge on its screen", () => {
    expect(
      knowledgeModuleIds({ type: 'MODULE', id: 'server' }, modules),
    ).toEqual(['server']);
  });

  it('[KG-1.6] shows the knowledge of the modules a product owns', () => {
    expect(
      knowledgeModuleIds({ type: 'PRODUCT', id: 'cloud' }, modules),
    ).toEqual(['server', 'webapp']);
  });

  it('[KG-1.6] shows the knowledge of the modules that hold a capability', () => {
    expect(
      knowledgeModuleIds(
        {
          type: 'CAPABILITY',
          id: 'checkout',
          moduleIds: ['billing', 'webapp', 'billing'],
        },
        modules,
      ),
    ).toEqual(['billing', 'webapp']);
  });
});

describe('linkRoute', () => {
  it('[KG-1.6] routes a link to a product or module by its key, and a capability by id', () => {
    expect(
      linkRoute(
        { entityType: 'PRODUCT', entityId: 'p-1', key: 'cloud' },
        'acme',
      ),
    ).toEqual({
      pathname: '/[workspaceSlug]/product/[productKey]',
      query: { workspaceSlug: 'acme', productKey: 'cloud' },
    });
    expect(
      linkRoute(
        { entityType: 'MODULE', entityId: 'm-1', key: 'server' },
        'acme',
      ),
    ).toEqual({
      pathname: '/[workspaceSlug]/module/[moduleKey]',
      query: { workspaceSlug: 'acme', moduleKey: 'server' },
    });
    expect(
      linkRoute({ entityType: 'CAPABILITY', entityId: 'c-1' }, 'acme'),
    ).toEqual({
      pathname: '/[workspaceSlug]/capability/[capabilityId]',
      query: { workspaceSlug: 'acme', capabilityId: 'c-1' },
    });
  });

  it('[KG-1.6] goes nowhere rather than to a blank page when a keyed link has no key', () => {
    expect(
      linkRoute({ entityType: 'MODULE', entityId: 'm-1' }, 'acme'),
    ).toBeNull();
    expect(
      linkRoute({ entityType: 'ISSUE', entityId: 'i-1' }, 'acme'),
    ).toBeNull();
  });
});

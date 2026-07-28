import { describe, expect, it } from 'vitest';

import { countIssuesByModule } from 'common/layouts/app-layout/module-row';
import type { IssueType } from 'common/types';

import { ModulesStore } from './store';

/**
 * Where a module appears in the sidebar.
 *
 * A module has exactly one owner: a team when it holds internal tools, and a
 * product when it ships to customers. These getters are what put it under that
 * owner and under nothing else. A module that appears in two places reads as
 * two modules, and a module that appears in neither is unreachable.
 */

const WORKSPACE = 'workspace-1';
const TEAM = 'team-engineering';
const PRODUCT = 'product-cloud';

interface ModuleSnapshot {
  id: string;
  createdAt: string;
  updatedAt: string;
  name: string;
  key: string;
  description: string | null;
  status: string | null;
  icon: string | null;
  color: string | null;
  leadUserId: string | null;
  ownerTeamId: string | null;
  ownerProductId: string | null;
  linkedTeamIds: string[];
  linkedProductIds: string[];
  workspaceId: string;
}

function module(overrides: Partial<ModuleSnapshot> = {}): ModuleSnapshot {
  return {
    id: 'module-1',
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
    name: 'Server',
    key: 'server',
    description: null,
    status: 'active',
    icon: null,
    color: null,
    leadUserId: null,
    ownerTeamId: null,
    ownerProductId: null,
    linkedTeamIds: [],
    linkedProductIds: [],
    workspaceId: WORKSPACE,
    ...overrides,
  };
}

const teamOwned = module({
  id: 'module-internal-tools',
  name: 'Internal tools',
  key: 'internal-tools',
  ownerTeamId: TEAM,
});

const productOwned = module({
  id: 'module-server',
  name: 'Server',
  key: 'server',
  ownerProductId: PRODUCT,
});

function buildStore(modules = [teamOwned, productOwned]) {
  return ModulesStore.create({ modules, workspaceId: WORKSPACE });
}

describe('ModulesStore ownership', () => {
  /**
   * The criterion this holds: a team-owned module appears under its team and
   * under no product. A module of internal tools ships to nobody, so no product
   * owns it, and the sidebar had no place for it at all before.
   */
  it('puts a team-owned module under its team', () => {
    const store = buildStore();

    expect(
      store
        .getModulesOwnedByTeam(TEAM)
        .map((found: ModuleSnapshot) => found.id),
    ).toEqual(['module-internal-tools']);
  });

  it('puts a team-owned module under no product', () => {
    const store = buildStore();

    expect(store.getModulesOwnedByProduct(PRODUCT)).toHaveLength(1);
    expect(store.getModulesOwnedByProduct(PRODUCT)[0].id).toBe('module-server');
    expect(store.getModulesLinkedToProduct(PRODUCT)).toHaveLength(0);
  });

  it('puts a product-owned module under no team', () => {
    const store = buildStore();

    expect(store.getModulesOwnedByTeam(TEAM)).toHaveLength(1);
    expect(store.getModulesLinkedToTeam(TEAM)).toHaveLength(0);
  });

  /**
   * A link is not ownership. A team that borrows a module of a product sees it
   * dimmed, and the product still owns it.
   */
  it('shows a borrowed module to the team that links it', () => {
    const store = buildStore([
      teamOwned,
      module({
        id: 'module-server',
        ownerProductId: PRODUCT,
        linkedTeamIds: [TEAM],
      }),
    ]);

    expect(
      store
        .getModulesOwnedByTeam(TEAM)
        .map((found: ModuleSnapshot) => found.id),
    ).toEqual(['module-internal-tools']);
    expect(
      store
        .getModulesLinkedToTeam(TEAM)
        .map((found: ModuleSnapshot) => found.id),
    ).toEqual(['module-server']);
  });

  it('does not list a module twice for the team that owns and links it', () => {
    const store = buildStore([
      module({
        id: 'module-internal-tools',
        ownerTeamId: TEAM,
        linkedTeamIds: [TEAM],
      }),
    ]);

    expect(store.getModulesOwnedByTeam(TEAM)).toHaveLength(1);
    expect(store.getModulesLinkedToTeam(TEAM)).toHaveLength(0);
  });

  it('gives an owner with nothing an empty list', () => {
    const store = buildStore();

    expect(store.getModulesOwnedByTeam('team-nobody')).toEqual([]);
    expect(store.getModulesOwnedByProduct('product-nobody')).toEqual([]);
  });
});

/**
 * The number beside a module in the sidebar. An issue can change two modules,
 * and it is work for both, so it counts for both.
 */
describe('countIssuesByModule', () => {
  const issue = (moduleIds: string[] | undefined) =>
    ({ id: `issue-${moduleIds?.join('-') ?? 'none'}`, moduleIds }) as IssueType;

  it('counts an issue once for each module that it names', () => {
    const counts = countIssuesByModule([
      issue(['module-server']),
      issue(['module-server', 'module-webapp']),
    ]);

    expect(counts.get('module-server')).toBe(2);
    expect(counts.get('module-webapp')).toBe(1);
  });

  it('counts nothing for a module that no issue names', () => {
    const counts = countIssuesByModule([issue(['module-server'])]);

    expect(counts.get('module-webapp')).toBeUndefined();
  });

  it('reads an issue whose module list was never set', () => {
    expect(() => countIssuesByModule([issue(undefined)])).not.toThrow();
    expect(countIssuesByModule([issue(undefined)]).size).toBe(0);
  });
});

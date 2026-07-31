import { type AgentScope } from '@vantikhq/types';

/**
 * The scope sets, named.
 *
 * The guard enforces individual scopes, but nobody thinks in scope lists — a
 * person deciding what a credential may do is picking a role, and reading
 * "can read, write" off a row is doing the translation in their head. So the
 * screen names the three combinations that exist and the code keeps the scopes.
 *
 * Deliberately not a free choice of scopes. Every combination outside these is
 * either meaningless (delete without read) or a way to build a credential
 * nobody can reason about later.
 */
export interface TokenRole {
  id: string;
  label: string;
  description: string;
  scopes: AgentScope[];
}

export const TOKEN_ROLES: TokenRole[] = [
  {
    id: 'reader',
    label: 'Read only',
    description: 'Can see the board. Cannot change anything.',
    scopes: ['read'],
  },
  {
    id: 'editor',
    label: 'Read and write',
    description: 'Can file, update, comment and close. Cannot delete.',
    scopes: ['read', 'write'],
  },
  {
    id: 'full',
    label: 'Read, write and delete',
    description: 'Everything, including the one verb that cannot be undone.',
    scopes: ['read', 'write', 'delete'],
  },
];

export const DEFAULT_ROLE_ID = 'editor';

export function roleById(id: string): TokenRole {
  return TOKEN_ROLES.find((role) => role.id === id) ?? TOKEN_ROLES[1];
}

/**
 * The role a set of scopes amounts to.
 *
 * Falls back to listing them when an agent holds a combination the roles do not
 * cover — provisioned before these existed, or minted over the API, which
 * still accepts any scopes. Showing the truth beats forcing it into a name that
 * would misstate what the guard enforces.
 */
export function roleLabelFor(scopes: string[] | undefined): string {
  if (!scopes?.length) {
    return 'No permissions';
  }

  const wanted = [...scopes].sort().join(',');
  const match = TOKEN_ROLES.find(
    (role) => [...role.scopes].sort().join(',') === wanted,
  );

  return match ? match.label : `Can ${scopes.join(', ')}`;
}

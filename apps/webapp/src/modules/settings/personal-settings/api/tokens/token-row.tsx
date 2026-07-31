import { Badge } from '@vantikhq/ui/components/badge';
import { Button } from '@vantikhq/ui/components/button';
import * as React from 'react';

import { roleLabelFor } from './roles';

/**
 * One access token, whichever identity it carries.
 *
 * There is one kind of credential here, not two. An agent token and a personal
 * token are rows in the same table, minted by the same generator, carrying the
 * same `tg_pat_` prefix and resolved by the same code — the column that differs
 * is `type`. Neither is tied to a transport: an agent token authenticates a
 * plain REST call exactly as a personal one does.
 *
 * What actually differs is who the token *is* when it calls, so that is what a
 * row says. A personal token resolves to you and carries your permissions; an
 * agent token resolves to a separate identity whose edits are attributed to it
 * and whose scopes the guard enforces on every request.
 */
export interface TokenRowData {
  id: string;
  name: string;
  /** Whose identity the token carries when it calls. */
  actsAs: 'you' | 'its own identity';
  /** Enforced for agent identities; a personal token carries your permissions. */
  scopes?: string[];
  /** Null means it has never authenticated — the sign of a leftover. */
  lastUsedAt?: string | null;
  /** An agent whose token has been revoked, kept for attribution. */
  revoked?: boolean;
  /** The address an agent identity authors as. */
  email?: string;
}

interface Props {
  token: TokenRowData;
  onRevoke: () => void;
  isRevoking?: boolean;
  error?: string | null;
}

export function TokenRow({ token, onRevoke, isRevoking, error }: Props) {
  const detail = [
    token.actsAs === 'you' ? 'Acts as you' : 'Acts as its own identity',
    // Named rather than listed: the guard enforces scopes, but a person reading
    // a row is asking what this credential is allowed to do.
    token.actsAs === 'you' ? 'your permissions' : roleLabelFor(token.scopes),
    used(token),
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="group flex items-center justify-between mb-2 bg-background-3 rounded-lg p-2 px-4">
      <div className="flex flex-col min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span>{token.name}</span>
          {token.actsAs === 'its own identity' && (
            <Badge variant="secondary">agent</Badge>
          )}
          {token.revoked && <Badge variant="outline">revoked</Badge>}
          {/* Only worth saying about a token that could still be used — a
              revoked one that was never used is not a loose end. */}
          {!token.revoked && token.lastUsedAt === null && (
            <Badge variant="outline">never used</Badge>
          )}
        </div>
        <span className="text-sm text-muted-foreground truncate">
          {detail}
        </span>
        {token.email && (
          <span className="text-sm text-muted-foreground truncate">
            {token.email}
          </span>
        )}
        {error && <span className="text-sm text-destructive">{error}</span>}
      </div>

      {!token.revoked && (
        <Button variant="secondary" isLoading={isRevoking} onClick={onRevoke}>
          revoke
        </Button>
      )}
    </div>
  );
}

/** When it last did anything, at the resolution the question is asked. */
function used(token: TokenRowData): string | null {
  // Personal tokens do not report this yet — `lastUsedAt` is written on the
  // agent path only — so say nothing rather than claim it was never used.
  if (token.lastUsedAt === undefined) {
    return null;
  }

  if (token.lastUsedAt === null) {
    return 'never used';
  }

  const minutes = Math.max(
    0,
    (Date.now() - Date.parse(token.lastUsedAt)) / 60000,
  );

  if (minutes < 60) {
    return 'used just now';
  }
  if (minutes < 60 * 24) {
    return `used ${Math.floor(minutes / 60)}h ago`;
  }

  return `used ${Math.floor(minutes / (60 * 24))}d ago`;
}

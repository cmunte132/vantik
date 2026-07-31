import { type AgentSummary, type Pat } from '@vantikhq/types';
import { Button } from '@vantikhq/ui/components/button';
import { Loader } from '@vantikhq/ui/components/loader';
import { observer } from 'mobx-react-lite';
import React from 'react';

import { useCurrentWorkspace } from 'hooks/workspace';

import { useDeletePatMutation } from 'services/users';
import { useGetAgentsQuery } from 'services/users/get-agents';
import { useGetPatsQuery } from 'services/users/get-pats';
import { useRevokeAgentMutation } from 'services/users/revoke-agent';

import { CreateToken } from './create-token';
import { TokenRow, type TokenRowData } from './token-row';

interface TokenListProps {
  /**
   * The token the create form is showing, and the setter it reports through.
   * Neither is read here: the page above owns the value, because the setup
   * instructions in the section below are what fill themselves in with it.
   */
  newToken: string | null;
  onNewToken: (token: string | null) => void;
}

/**
 * Every access token you hold, in one list.
 *
 * Two queries because the server keeps two listings, not because there are two
 * kinds of thing: both return rows of the same `PersonalAccessToken` table,
 * split only by the `type` column. Merging them here is what stops the screen
 * inventing a distinction the system does not have.
 *
 * Revoking is two calls for the same reason — an agent's revoke soft-deletes
 * its tokens and keeps the identity so its past edits stay attributed, while a
 * personal token simply goes.
 */
export const TokenList = observer(
  ({ newToken, onNewToken }: TokenListProps) => {
    const workspace = useCurrentWorkspace();
    const [showRevoked, setShowRevoked] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const { data: pats, isLoading: loadingPats } = useGetPatsQuery();
    const { data: agents, isLoading: loadingAgents } = useGetAgentsQuery(
      workspace?.id,
      Boolean(workspace?.id),
      'mine',
    );

    const { mutate: deletePat } = useDeletePatMutation({});
    const { mutate: revokeAgent } = useRevokeAgentMutation({
      onMutate: () => setError(null),
      onError: setError,
    });

    if (!workspace) {
      return null;
    }

    const rows: TokenRowData[] = [
      ...(agents ?? []).map((agent: AgentSummary) => ({
        id: agent.id,
        name: agent.name,
        actsAs: 'its own identity' as const,
        scopes: agent.scopes,
        lastUsedAt: agent.lastUsedAt,
        revoked: !agent.active,
        email: agent.email,
      })),
      ...(pats ?? []).map((pat: Pat) => ({
        id: pat.id,
        name: pat.name,
        actsAs: 'you' as const,
      })),
    ];

    const live = rows.filter((row) => !row.revoked);
    const revoked = rows.filter((row) => row.revoked);

    const revoke = (row: TokenRowData) =>
      row.actsAs === 'its own identity'
        ? revokeAgent({ agentId: row.id, workspaceId: workspace.id })
        : deletePat({ patId: row.id });

    return (
      <div className="flex flex-col">
        <CreateToken
          workspaceId={workspace.id}
          token={newToken}
          onToken={onNewToken}
        />

        {(loadingPats || loadingAgents) && <Loader />}

        {!loadingPats && !loadingAgents && live.length === 0 && (
          <p className="text-muted-foreground">
            You have no access tokens yet.
          </p>
        )}

        {live.map((row) => (
          <TokenRow
            key={row.id}
            token={row}
            error={error}
            onRevoke={() => revoke(row)}
          />
        ))}

        {/* A revoked identity can do nothing and never will again, so it stops
            competing for space with the tokens that work. Kept reachable rather
            than dropped: it is the record of a credential that once existed. */}
        {revoked.length > 0 && (
          <div className="flex flex-col gap-2 mt-1">
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => setShowRevoked(!showRevoked)}
            >
              {showRevoked ? 'Hide' : 'Show'} {revoked.length} revoked
            </Button>

            {showRevoked &&
              revoked.map((row) => (
                <TokenRow key={row.id} token={row} onRevoke={() => undefined} />
              ))}
          </div>
        )}
      </div>
    );
  },
);

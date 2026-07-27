import { type AgentSummary } from '@vantikhq/types';
import { Badge } from '@vantikhq/ui/components/badge';
import { Button } from '@vantikhq/ui/components/button';
import * as React from 'react';

import { useRevokeAgentMutation } from 'services/users/revoke-agent';

interface AgentItemProps {
  agent: AgentSummary;
  workspaceId: string;
}

export function AgentItem({ agent, workspaceId }: AgentItemProps) {
  // Revoking is the one destructive thing on this screen; a failure that only
  // showed up as the row staying put would read as nothing having happened.
  const [error, setError] = React.useState<string | null>(null);
  const { mutate: revoke, isPending } = useRevokeAgentMutation({
    onMutate: () => setError(null),
    onError: (message) => setError(message),
  });

  return (
    <div className="group flex items-center justify-between mb-2 bg-background-3 rounded-lg p-2 px-4">
      <div className="flex flex-col">
        <div className="flex items-center gap-2">
          <span>{agent.name}</span>
          <Badge variant="secondary">{agent.ownership}</Badge>
          {!agent.active && <Badge variant="outline">revoked</Badge>}
          {/* The signal that an account is a leftover rather than something
              live. Only worth saying about an agent that could still act — a
              revoked one that was never used is not a loose end. */}
          {agent.active && !agent.lastUsedAt && (
            <Badge variant="outline">never used</Badge>
          )}
        </div>
        <span className="text-sm text-muted-foreground">
          {agent.email} · can {agent.scopes.join(', ')} · {used(agent)}
        </span>
        {error && <span className="text-sm text-destructive">{error}</span>}
      </div>

      {agent.active && (
        <Button
          variant="secondary"
          isLoading={isPending}
          onClick={() => revoke({ agentId: agent.id, workspaceId })}
        >
          revoke
        </Button>
      )}
    </div>
  );
}

/**
 * When this agent last did anything, at the resolution the question is asked.
 *
 * "Never used" is the answer that matters — it is what separates a leftover
 * from an account in daily use — so it is said plainly rather than shown as an
 * empty space.
 */
function used(agent: AgentSummary): string {
  if (!agent.lastUsedAt) {
    return 'never used';
  }

  const minutes = Math.max(0, (Date.now() - Date.parse(agent.lastUsedAt)) / 60000);

  if (minutes < 60) {
    return 'used just now';
  }
  if (minutes < 60 * 24) {
    return `used ${Math.floor(minutes / 60)}h ago`;
  }

  return `used ${Math.floor(minutes / (60 * 24))}d ago`;
}

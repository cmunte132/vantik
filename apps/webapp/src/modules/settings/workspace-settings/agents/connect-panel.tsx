import { type AgentScope } from '@vantikhq/types';
import { Button } from '@vantikhq/ui/components/button';
import { Checkbox } from '@vantikhq/ui/components/checkbox';
import { Input } from '@vantikhq/ui/components/input';
import * as React from 'react';

import { useCreateAgentMutation } from 'services/users/create-agent';

import { InstallConfig } from './install-config';

/**
 * The one way to provision an agent: name it, generate a token, paste the
 * config. Generating creates the account behind the scenes — it shows up in the
 * list below, where it can be revoked — so the whole "how do I connect this?"
 * question is one button and a copy.
 *
 * Read and write are always granted; deletion is the one verb that has to be
 * asked for, so an agent cannot remove work by default.
 *
 * The new agent appears in the list below without this telling it to: the
 * mutation invalidates that query, which is what refetches it.
 */
export function ConnectPanel({ workspaceId }: { workspaceId: string }) {
  const [name, setName] = React.useState('My agent');
  const [mayDelete, setMayDelete] = React.useState(false);
  const [token, setToken] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const { mutate: createAgent, isPending } = useCreateAgentMutation({
    onError: (message) => setError(message),
    onSuccess: (data) => setToken(data.token),
  });

  const onGenerate = () => {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Give the agent a name.');
      return;
    }

    const scopes: AgentScope[] = mayDelete
      ? ['read', 'write', 'delete']
      : ['read', 'write'];

    createAgent({ name: trimmed, scopes, workspaceId });
  };

  return (
    <div className="rounded-lg border border-border bg-background-2 p-5 mb-6">
      <h3 className="text-lg">Connect your agent</h3>
      <p className="text-muted-foreground mb-4">
        Connect Claude Code, Codex, Cursor, or any MCP client to Vantik.
        Generate a token, then copy the config for your tool below.
      </p>

      {token ? (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <p className="text-sm">
              Connected as <span className="font-medium">{name}</span>. Copy the
              config for your harness:
            </p>
            <Button
              variant="ghost"
              onClick={() => {
                setToken(null);
                setName('My agent');
                setMayDelete(false);
              }}
            >
              Connect another
            </Button>
          </div>
          <InstallConfig token={token} />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-end gap-3">
            <div className="flex flex-col gap-1 grow max-w-[280px]">
              <label
                className="text-sm text-muted-foreground"
                htmlFor="agent-name"
              >
                Agent name
              </label>
              <Input
                id="agent-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && onGenerate()}
                placeholder="My agent"
              />
            </div>
            <Button
              size="lg"
              variant="secondary"
              isLoading={isPending}
              onClick={onGenerate}
            >
              Generate token &amp; config
            </Button>
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={mayDelete}
              onCheckedChange={(checked) => setMayDelete(checked === true)}
            />
            Let this agent delete things. It can already read, file and update
            without this.
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="mt-2 opacity-70">
            <p className="text-sm text-muted-foreground mb-2">
              Preview — generate a token above to fill these in:
            </p>
            <InstallConfig />
          </div>
        </div>
      )}
    </div>
  );
}

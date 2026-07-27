import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@vantikhq/ui/components/button';
import { Input } from '@vantikhq/ui/components/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vantikhq/ui/components/select';
import * as React from 'react';

import { useCreateAgentMutation } from 'services/users/create-agent';
import { useCreatePatMutation } from 'services/users/create-pat';
import { GetPats } from 'services/users/get-pats';

import { InstallConfig } from '../agents/install-config';
import { DEFAULT_ROLE_ID, TOKEN_ROLES, roleById } from './roles';

/**
 * Minting an access token: who it is, and what it may do.
 *
 * Both branches produce the same object — a row in `PersonalAccessToken` with
 * the same prefix, resolved by the same code. So the form asks the two
 * questions that actually differ, in the order access control is normally
 * described: the principal, then its role.
 *
 * A token acting as you carries your own permissions, so the role is not a
 * choice in that case and says so rather than offering one that would be
 * ignored.
 */
export function CreateToken({ workspaceId }: { workspaceId: string }) {
  const queryClient = useQueryClient();

  const [name, setName] = React.useState('');
  const [identity, setIdentity] = React.useState('agent');
  const [roleId, setRoleId] = React.useState(DEFAULT_ROLE_ID);
  const [token, setToken] = React.useState<string | null>(null);
  const [createdName, setCreatedName] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const isAgent = identity === 'agent';

  const { mutate: createAgent, isPending: creatingAgent } =
    useCreateAgentMutation({
      onError: setError,
      onSuccess: (data) => setToken(data.token),
    });

  const { mutate: createPat, isPending: creatingPat } = useCreatePatMutation({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onSuccess: (data: any) => {
      // `useCreatePatMutation` invalidates nothing — the screen this used to
      // live on refetched by hand. Without this the token is created and never
      // appears in the list beside it.
      queryClient.invalidateQueries({ queryKey: [GetPats] });
      setToken(data?.token ?? null);
    },
  });

  const create = () => {
    setError(null);
    const trimmed = name.trim();

    if (!trimmed) {
      setError('Give the token a name.');
      return;
    }

    setCreatedName(trimmed);

    if (isAgent) {
      createAgent({
        name: trimmed,
        scopes: roleById(roleId).scopes,
        workspaceId,
      });
      return;
    }

    createPat({ name: trimmed });
  };

  const reset = () => {
    setToken(null);
    setName('');
    setError(null);
  };

  // The one moment the credential exists. Dismissing is deliberate, because
  // navigating away loses it for good.
  if (token) {
    return (
      <div className="flex flex-col gap-4 mb-4">
        <p className="text-muted-foreground">
          <span className="text-foreground">{createdName}</span> is ready. Copy
          the token now — it is shown once and cannot be retrieved again. If you
          lose it, revoke it and create another.
        </p>

        <InstallConfig token={token} />

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={reset}>
            Done
          </Button>
          <Button variant="ghost" size="sm" onClick={reset}>
            Create another
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 mb-4 max-w-[500px]">
      <Field label="Name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
          placeholder={isAgent ? 'Claude Code' : 'Deploy script'}
        />
      </Field>

      <Field label="Acts as">
        <Select value={identity} onValueChange={setIdentity}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="agent">
                Its own identity — an agent
              </SelectItem>
              <SelectItem value="me">You</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <p className="text-sm text-muted-foreground">
          {isAgent
            ? 'Its edits are attributed to it, not to you.'
            : 'Carries your account, and everything it does is attributed to you.'}
        </p>
      </Field>

      <Field label="Role">
        {isAgent ? (
          <>
            <Select value={roleId} onValueChange={setRoleId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {TOKEN_ROLES.map((role) => (
                    <SelectItem key={role.id} value={role.id}>
                      {role.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              {roleById(roleId).description}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Your own — a token acting as you cannot be given less than you have.
          </p>
        )}
      </Field>

      <div>
        <Button isLoading={creatingAgent || creatingPat} onClick={create}>
          Create
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

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

import { CopyBlock } from '../copy-block';
import { DEFAULT_ROLE_ID, TOKEN_ROLES, roleById } from './roles';

interface CreateTokenProps {
  workspaceId: string;
  /**
   * The token this form just minted, held by the page rather than here. It is
   * shown once, and the setup instructions further down the page are what a
   * person does with it, so the page is where both can see it.
   */
  token: string | null;
  onToken: (token: string | null) => void;
}

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
export function CreateToken({ workspaceId, token, onToken }: CreateTokenProps) {
  const queryClient = useQueryClient();

  const [name, setName] = React.useState('');
  const [identity, setIdentity] = React.useState('agent');
  const [roleId, setRoleId] = React.useState(DEFAULT_ROLE_ID);
  const [createdName, setCreatedName] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const isAgent = identity === 'agent';

  const { mutate: createAgent, isPending: creatingAgent } =
    useCreateAgentMutation({
      onError: setError,
      onSuccess: (data) => onToken(data.token),
    });

  const { mutate: createPat, isPending: creatingPat } = useCreatePatMutation({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onSuccess: (data: any) => {
      // `useCreatePatMutation` invalidates nothing — the screen this used to
      // live on refetched by hand. Without this the token is created and never
      // appears in the list beside it.
      queryClient.invalidateQueries({ queryKey: [GetPats] });
      onToken(data?.token ?? null);
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
    onToken(null);
    setName('');
    setError(null);
  };

  // The one moment the credential exists. Dismissing is deliberate, because
  // navigating away loses it for good.
  //
  // The secret itself is all this shows. It used to render the whole connection
  // guide underneath, which put a second copy of the harness tabs, the config
  // blocks and the skill install on a page that already had them in their own
  // section below — the same instructions twice, differing only in whether the
  // token in them was real. Now the section below fills itself in instead.
  if (token) {
    return (
      <div className="flex flex-col gap-4 mb-4">
        <p className="text-muted-foreground">
          <span className="text-foreground">{createdName}</span> is ready. Copy
          the token now — it is shown once and cannot be retrieved again. If you
          lose it, revoke it and create another.
        </p>

        {/* Its own bordered region rather than a line of body text: this is the
            only moment the credential exists, and it has to look like it. */}
        <div className="flex flex-col gap-2 rounded-md border border-warning/50 bg-warning/10 p-3">
          <CopyBlock label="Token — copy it now" value={token} />
        </div>

        <p className="text-sm text-muted-foreground">
          Connecting a client, below, is filled in with it until you dismiss
          this.
        </p>

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={reset}>
            Done
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

import { Button } from '@vantikhq/ui/components/button';
import { Input } from '@vantikhq/ui/components/input';
import * as React from 'react';

import {
  type CredentialHandle,
  type CredentialKind,
  usePutCredentialMutation,
  useRemoveCredentialMutation,
} from 'services/workspace-credentials';

interface Props {
  kind: CredentialKind;
  /** What is missing without it, said as a consequence rather than a warning. */
  whenAbsent: string;
  handle?: CredentialHandle;
  /** Model keys belong to an endpoint; a git token does not. */
  withBaseUrl?: boolean;
  placeholder: string;
}

/**
 * One workspace secret: whether it is set, and how to change it.
 *
 * What it is and why it matters are the surrounding `SettingSection`'s job, the
 * way every other settings page does it — this is only the control.
 *
 * The screen never sees a stored secret and is built on that basis: the server
 * has no route that returns one. So there is no masked input to reveal and no
 * "check the current value". A credential is replaced or removed, and the only
 * evidence it is the right one is the four-character hint.
 *
 * Add and replace are the same call, because the store keeps one credential of
 * each kind per workspace and upserts. Offering them as two actions would imply
 * a second slot that does not exist.
 */
export function CredentialBlock({
  kind,
  whenAbsent,
  handle,
  withBaseUrl,
  placeholder,
}: Props) {
  const [editing, setEditing] = React.useState(false);
  const [secret, setSecret] = React.useState('');
  const [baseUrl, setBaseUrl] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const close = () => {
    setEditing(false);
    setSecret('');
    setBaseUrl('');
    setError(null);
  };

  const { mutate: put, isPending } = usePutCredentialMutation({
    onSuccess: close,
    onError: setError,
  });

  const { mutate: remove } = useRemoveCredentialMutation({ onError: setError });

  const save = () => {
    const trimmed = secret.trim();

    if (!trimmed) {
      // The server rejects this too. Saying so here saves a round trip for the
      // one mistake everybody makes.
      setError('Paste the key before saving.');
      return;
    }

    put({
      kind,
      secret: trimmed,
      ...(withBaseUrl && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
    });
  };

  if (editing) {
    return (
      <div className="flex flex-col gap-3 max-w-[500px]">
        <Input
          autoFocus
          type="password"
          value={secret}
          placeholder={placeholder}
          onChange={(e) => setSecret(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              save();
            }
            if (e.key === 'Escape') {
              close();
            }
          }}
        />

        {withBaseUrl && (
          <Input
            value={baseUrl}
            placeholder="Endpoint — leave empty for the provider default"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        )}

        <div className="flex items-center gap-2">
          <Button size="sm" isLoading={isPending} onClick={save}>
            Save
          </Button>
          <Button variant="ghost" size="sm" onClick={close}>
            Cancel
          </Button>
        </div>

        <p className="text-muted-foreground text-sm">
          Stored encrypted. It is never shown again after this.
        </p>

        {error && <p className="text-destructive text-sm">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 max-w-[500px]">
      <div className="flex flex-col">
        {handle ? (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono">{handle.hint}</span>
              {handle.baseUrl && (
                <span className="text-muted-foreground">{handle.baseUrl}</span>
              )}
            </div>
            <span className="text-muted-foreground text-sm">
              {handle.rotatedAt
                ? `Rotated ${when(handle.rotatedAt)}`
                : `Added ${when(handle.updatedAt)}`}
            </span>
          </>
        ) : (
          <>
            <span>Not set</span>
            <span className="text-muted-foreground text-sm">{whenAbsent}</span>
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
          {handle ? 'Replace' : 'Add'}
        </Button>

        {handle && (
          <Button variant="ghost" size="sm" onClick={() => remove({ kind })}>
            Remove
          </Button>
        )}
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}
    </div>
  );
}

/** How long ago, at the resolution a credential is actually thought about. */
function when(at: string): string {
  const days = Math.floor((Date.now() - Date.parse(at)) / 86400000);

  if (days < 1) {
    return 'today';
  }
  if (days === 1) {
    return 'yesterday';
  }
  if (days < 30) {
    return `${days} days ago`;
  }

  return new Date(at).toLocaleDateString();
}

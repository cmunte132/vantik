import { Button } from '@vantikhq/ui/components/button';
import { useToast } from '@vantikhq/ui/components/use-toast';
import React from 'react';
import {
  registerPasskey,
  doesBrowserSupportWebAuthn,
  listCredentials,
  removeCredential,
} from 'services/auth';

interface Credential {
  webauthnCredentialId: string;
  createdAt: number;
}

export function Passkeys() {
  const { toast } = useToast();
  const [credentials, setCredentials] = React.useState<Credential[]>([]);
  const [supported, setSupported] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const refresh = React.useCallback(async () => {
    const response = await listCredentials();
    setCredentials(response.status === 'OK' ? response.credentials : []);
  }, []);

  React.useEffect(() => {
    doesBrowserSupportWebAuthn()
      .then((response) =>
        setSupported(
          response.status === 'OK' && response.browserSupportsWebauthn,
        ),
      )
      .catch(() => setSupported(false));

    refresh();
  }, [refresh]);

  const failed = (description: string) => {
    toast({ variant: 'destructive', title: 'Error!', description });
  };

  const onAdd = async () => {
    setBusy(true);
    try {
      const response = await registerPasskey();
      if (response.status === 'OK') {
        toast({
          title: 'Saved!',
          description: 'That passkey can now sign you in.',
        });
        await refresh();
      } else if (response.status === 'SIGN_UP_NOT_ALLOWED') {
        failed(response.reason || 'Creating a passkey is not allowed.');
      } else {
        failed('Could not add that passkey. Please try again.');
      }
    } catch {
      failed('Could not add that passkey. Please try again.');
    }
    setBusy(false);
  };

  const onRemove = async (webauthnCredentialId: string) => {
    setBusy(true);
    try {
      const response = await removeCredential({
        webauthnCredentialId,
      });

      if (response.status === 'OK') {
        await refresh();
      } else {
        failed('Could not remove that passkey. Please try again.');
      }
    } catch {
      failed('Could not remove that passkey. Please try again.');
    }
    setBusy(false);
  };

  if (!supported) {
    return (
      <div className="text-muted-foreground">
        This browser cannot use passkeys. Sign in with a login code instead.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="mb-4">
        <Button variant="secondary" size="lg" disabled={busy} onClick={onAdd}>
          Add a passkey
        </Button>
      </div>

      <div>
        {credentials.map((credential) => (
          <div
            className="group flex justify-between mb-2 bg-background-3 rounded-lg p-2 px-4"
            key={credential.webauthnCredentialId}
          >
            <div className="flex items-center justify-center gap-3">
              <div>
                Added {new Date(credential.createdAt).toLocaleDateString()}
              </div>
            </div>

            <div>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => onRemove(credential.webauthnCredentialId)}
              >
                remove
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

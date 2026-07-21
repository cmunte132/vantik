import { Button } from '@vantikhq/ui/components/button';
import { useToast } from '@vantikhq/ui/components/use-toast';
import React from 'react';
import {
  createAndRegisterCredentialForSessionUser,
  doesBrowserSupportWebAuthn,
  listCredentials,
  registerCredentialWithSignUp,
  removeCredential,
} from 'supertokens-web-js/recipe/webauthn';

import { UserContext } from 'store/user-context';

interface Credential {
  webauthnCredentialId: string;
  createdAt: number;
  recipeUserId: string;
}

export function Passkeys() {
  const user = React.useContext(UserContext);
  const { toast } = useToast();
  const [credentials, setCredentials] = React.useState<Credential[]>([]);
  const [supported, setSupported] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const refresh = React.useCallback(async () => {
    const response = await listCredentials({ userContext: {} });
    setCredentials(response.status === 'OK' ? response.credentials : []);
  }, []);

  React.useEffect(() => {
    doesBrowserSupportWebAuthn({ userContext: {} })
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
      // The first passkey and every later one take different routes. Adding a
      // credential needs a webauthn login method to hang it off, which an
      // account that has only ever used login codes does not have yet, so the
      // first one is a signup carrying the session: SuperTokens creates the
      // login method and links it to the account that is already signed in.
      const existing = credentials[0];
      const response = existing
        ? await createAndRegisterCredentialForSessionUser({
            email: user.email,
            recipeUserId: existing.recipeUserId,
            userContext: {},
          })
        : await registerCredentialWithSignUp({
            email: user.email,
            shouldTryLinkingWithSessionUser: true,
            userContext: {},
          });

      if (response.status === 'OK') {
        toast({
          title: 'Saved!',
          description: 'That passkey can now sign you in.',
        });
        await refresh();
      } else if (response.status === 'AUTHENTICATOR_ALREADY_REGISTERED') {
        failed('That passkey is already on your account.');
      } else if (response.status === 'INVALID_EMAIL_ERROR') {
        failed(response.err);
      } else if (
        response.status !== 'FAILED_TO_REGISTER_USER' &&
        response.status !== 'WEBAUTHN_NOT_SUPPORTED'
      ) {
        // A dismissed system prompt lands in FAILED_TO_REGISTER_USER, and
        // someone who cancelled on purpose does not need to be told.
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
        userContext: {},
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

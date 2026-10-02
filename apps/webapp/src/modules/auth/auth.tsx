/* eslint-disable react/no-unescaped-entities */
import { zodResolver } from '@hookform/resolvers/zod';
import { RiArrowLeftLine, RiInboxLine } from '@remixicon/react';
import { RiFingerprintFill, RiMailFill } from '@remixicon/react';
import { Button } from '@vantikhq/ui/components/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from '@vantikhq/ui/components/form';
import { Input } from '@vantikhq/ui/components/input';
import { useToast } from '@vantikhq/ui/components/use-toast';
import React from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { AuthLayout } from 'common/layouts/auth-layout';
import { useRouter } from 'common/router';
import { safeRedirectPath } from 'common/safe-redirect';
import { AuthGuard } from 'common/wrappers/auth-guard';

import {
  authenticateCredentialWithSignIn,
  consumeCode,
  createCode,
  doesBrowserSupportWebAuthn,
  registerPasskey,
} from 'services/auth';

export const AuthSchema = z.object({
  email: z.string().email(),
});

export function Auth() {
  const form = useForm<z.infer<typeof AuthSchema>>({
    resolver: zodResolver(AuthSchema),
    defaultValues: {
      email: '',
    },
  });
  const [emailSent, setEmailSent] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [code, setCode] = React.useState('');
  const [preAuthSessionId, setPreAuthSessionId] = React.useState('');
  const [verifying, setVerifying] = React.useState(false);
  const [passkeySupported, setPasskeySupported] = React.useState(false);
  const [passkeyLoading, setPasskeyLoading] = React.useState(false);
  const { toast } = useToast();
  const router = useRouter();
  const redirectToPath = router.query.redirectToPath;

  // Asked rather than assumed: the passkey controls stay hidden on browsers
  // that would only fail once pressed.
  React.useEffect(() => {
    doesBrowserSupportWebAuthn()
      .then((response) => {
        setPasskeySupported(
          response.status === 'OK' && response.browserSupportsWebauthn,
        );
      })
      .catch(() => setPasskeySupported(false));
  }, []);

  const onAuthenticated = () => {
    router.replace(safeRedirectPath(redirectToPath));
  };

  const passkeyError = (description: string) => {
    toast({ variant: 'destructive', title: 'Error!', description });
  };

  // No email is asked for here. The browser already knows which passkeys it
  // holds for this site and prompts the user to pick one, so a returning user
  // types nothing at all.
  const onPasskeySignIn = async () => {
    setPasskeyLoading(true);
    try {
      const response = await authenticateCredentialWithSignIn();

      if (response.status === 'OK') {
        onAuthenticated();
      } else if (response.status === 'SIGN_IN_NOT_ALLOWED') {
        passkeyError(response.reason);
      } else if (response.status === 'WEBAUTHN_NOT_SUPPORTED') {
        passkeyError('This browser cannot use passkeys. Use your email.');
      } else if (response.status !== 'FAILED_TO_AUTHENTICATE_USER') {
        // FAILED_TO_AUTHENTICATE_USER is what a cancelled system prompt looks
        // like, and someone who dismissed the dialog does not need telling.
        passkeyError('That passkey did not work. Try your email instead.');
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: unknown) {
      passkeyError(
        err instanceof Error ? err.message : 'Oops! Something went wrong.',
      );
    }
    setPasskeyLoading(false);
  };

  // Creating an account with a passkey and nothing else. This is the only way
  // in on an install with no mail server, since there is no inbox to send a
  // code to.
  const onPasskeySignUp = async ({ email }: { email: string }) => {
    setPasskeyLoading(true);
    try {
      const response = await registerPasskey({ email });

      if (response.status === 'OK') {
        onAuthenticated();
      } else if (response.status === 'SIGN_UP_NOT_ALLOWED') {
        passkeyError(response.reason);
      } else if (response.status !== 'FAILED_TO_REGISTER_USER') {
        passkeyError('Could not create that passkey. Try your email instead.');
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: unknown) {
      passkeyError(
        err instanceof Error ? err.message : 'Oops! Something went wrong.',
      );
    }
    setPasskeyLoading(false);
  };

  const onSubmit = async ({ email }: { email: string }) => {
    setLoading(true);
    try {
      const response = await createCode({
        email,
      });
      setPreAuthSessionId(response.preAuthSessionId);
      setEmailSent(true);
    } catch (err: unknown) {
      console.log(err);
      toast({
        variant: 'destructive',
        title: 'Error!',
        description:
          err instanceof Error ? err.message : 'Oops! Something went wrong.',
      });
    }

    setLoading(false);
  };

  // Consume the one-time code the user types in. This keeps login inside the
  // current browser context, which is what lets it work in an installed PWA:
  // on iOS a tapped magic link opens in Safari, a separate context from the
  // standalone app, so the code path is the only way to finish signing in
  // without leaving the app.
  const onVerifyCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setVerifying(true);
    try {
      const response = await consumeCode({
        preAuthSessionId,
        userInputCode: code.trim(),
      });

      if (response.status === 'OK') {
        router.replace(safeRedirectPath(redirectToPath));
      } else if (response.status === 'INCORRECT_USER_INPUT_CODE_ERROR') {
        const left =
          response.maximumCodeInputAttempts -
          response.failedCodeInputAttemptCount;
        toast({
          variant: 'destructive',
          title: 'Incorrect code',
          description: `Please try again. ${left} attempt${
            left === 1 ? '' : 's'
          } left.`,
        });
      } else {
        toast({
          variant: 'destructive',
          title: 'Error!',
          description: 'Login failed. Please try again.',
        });
        setCode('');
        setEmailSent(false);
      }
    } catch (err: unknown) {
      toast({
        variant: 'destructive',
        title: 'Error!',
        description:
          err instanceof Error ? err.message : 'Oops! Something went wrong.',
      });
    }
    setVerifying(false);
  };

  if (emailSent) {
    return (
      <AuthLayout>
        <div className="flex flex-col w-[360px] gap-6">
          <div className="flex flex-col gap-4 items-center">
            <RiInboxLine size={32} />
            <h1 className="text-lg text-center">Check your email</h1>
            <div className="text-center text-muted-foreground">
              We sent a login code and a magic link to your email. Enter the
              code below, or open the link on this device.
            </div>
          </div>

          <form onSubmit={onVerifyCode} className="flex flex-col gap-2">
            <Input
              placeholder="Enter login code"
              className="h-9 text-center tracking-[0.3em]"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoFocus
            />
            <Button
              size="xl"
              full
              type="submit"
              isLoading={verifying}
              variant="secondary"
              disabled={!code.trim()}
            >
              Verify code
            </Button>
          </form>

          <div className="flex justify-start items-center">
            <Button
              variant="ghost"
              className="flex items-center gap-1"
              onClick={() => {
                setCode('');
                setEmailSent(false);
              }}
            >
              <RiArrowLeftLine size={14} />
              Re-enter email
            </Button>
          </div>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <div className="flex flex-col w-[360px]">
        <h1 className="text-lg text-center">Welcome</h1>
        <div className="text-center text-muted-foreground mt-1 mb-8">
          Create an account or login
        </div>

        <div className="flex flex-col gap-2">
          {passkeySupported && (
            <>
              <Button
                className="flex gap-2"
                size="xl"
                full
                variant="secondary"
                isLoading={passkeyLoading}
                onClick={onPasskeySignIn}
              >
                <RiFingerprintFill size={18} /> Sign in with a passkey
              </Button>

              <div className="flex items-center gap-3 my-2 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                or
                <span className="h-px flex-1 bg-border" />
              </div>
            </>
          )}

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-2">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input
                        placeholder="Email address"
                        className="h-9"
                        autoComplete="username webauthn"
                        {...field}
                      />
                    </FormControl>

                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex flex-col gap-2">
                <Button
                  className="flex gap-2"
                  size="xl"
                  full
                  type="submit"
                  isLoading={loading}
                  variant="secondary"
                >
                  <RiMailFill size={18} /> Send a magic link
                </Button>

                {passkeySupported && (
                  <Button
                    className="flex gap-2"
                    size="xl"
                    full
                    type="button"
                    variant="ghost"
                    isLoading={passkeyLoading}
                    onClick={form.handleSubmit(onPasskeySignUp)}
                  >
                    Create an account with a passkey
                  </Button>
                )}
              </div>
            </form>
          </Form>
        </div>

        <div className="mt-4 text-xs text-muted-foreground">
          By clicking continue, you agree to our Terms of Service and Privacy
          Policy.
        </div>
      </div>
    </AuthLayout>
  );
}

Auth.getLayout = function getLayout(page: React.ReactElement) {
  return <AuthGuard>{page}</AuthGuard>;
};

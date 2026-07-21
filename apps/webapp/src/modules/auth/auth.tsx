/* eslint-disable react/no-unescaped-entities */
import { zodResolver } from '@hookform/resolvers/zod';
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
import { ArrowLeft, Inbox } from '@vantikhq/ui/icons';
import { useRouter } from 'next/router';
import posthog from 'posthog-js';
import React from 'react';
import { useForm } from 'react-hook-form';
import {
  createCode,
  consumeCode,
  clearLoginAttemptInfo,
} from 'supertokens-web-js/recipe/passwordless';
import {
  authenticateCredentialWithSignIn,
  doesBrowserSupportWebAuthn,
  registerCredentialWithSignUp,
} from 'supertokens-web-js/recipe/webauthn';
import { z } from 'zod';

import { AuthLayout } from 'common/layouts/auth-layout';
import { AuthGuard } from 'common/wrappers/auth-guard';

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
  const [verifying, setVerifying] = React.useState(false);
  const [passkeySupported, setPasskeySupported] = React.useState(false);
  const [passkeyLoading, setPasskeyLoading] = React.useState(false);
  const { toast } = useToast();
  const router = useRouter();
  const redirectToPath = router.query.redirectToPath;

  // Asked rather than assumed: the passkey controls stay hidden on browsers
  // that would only fail once pressed.
  React.useEffect(() => {
    doesBrowserSupportWebAuthn({ userContext: {} })
      .then((response) => {
        setPasskeySupported(
          response.status === 'OK' && response.browserSupportsWebauthn,
        );
      })
      .catch(() => setPasskeySupported(false));
  }, []);

  const onAuthenticated = () => {
    router.replace(redirectToPath ? (redirectToPath as string) : '/');
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
      const response = await authenticateCredentialWithSignIn({
        userContext: {},
      });

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
    } catch (err: any) {
      passkeyError(
        err.isSuperTokensGeneralError
          ? err.message
          : 'Oops! Something went wrong.',
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
      const response = await registerCredentialWithSignUp({
        email,
        userContext: {},
      });

      if (response.status === 'OK') {
        posthog.capture('user_signed_up', { email });
        onAuthenticated();
      } else if (response.status === 'SIGN_UP_NOT_ALLOWED') {
        passkeyError(response.reason);
      } else if (
        response.status === 'EMAIL_ALREADY_EXISTS_ERROR' ||
        response.status === 'INVALID_CREDENTIALS_ERROR'
      ) {
        // The account exists but this passkey is not attached to it, and an
        // unproven email address is not enough to attach one. Proving the
        // inbox first is the way through.
        passkeyError(
          'That email already has an account. Sign in with a login code, then add a passkey from settings.',
        );
      } else if (response.status === 'AUTHENTICATOR_ALREADY_REGISTERED') {
        passkeyError('That passkey is already registered. Sign in with it.');
      } else if (response.status === 'INVALID_EMAIL_ERROR') {
        passkeyError(response.err);
      } else if (response.status !== 'FAILED_TO_REGISTER_USER') {
        passkeyError('Could not create that passkey. Try your email instead.');
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      passkeyError(
        err.isSuperTokensGeneralError
          ? err.message
          : 'Oops! Something went wrong.',
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

      if (response.status === 'SIGN_IN_UP_NOT_ALLOWED') {
        // the reason string is a user friendly message
        // about what went wrong. It can also contain a support code which users
        // can tell you so you know why their sign in / up was not allowed.
        toast({
          variant: 'destructive',
          title: 'Error!',
          description: response.reason,
        });
      } else {
        setEmailSent(true);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      console.log(err);
      if (err.isSuperTokensGeneralError === true) {
        // this may be a custom error message sent from the API by you,
        toast({
          variant: 'destructive',
          title: 'Error!',
          description: err.message,
        });
      } else {
        toast({
          variant: 'destructive',
          title: 'Error!',
          description: 'Oops! Something went wrong.',
        });
      }
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
      const response = await consumeCode({ userInputCode: code.trim() });

      if (response.status === 'OK') {
        await clearLoginAttemptInfo();
        if (
          response.createdNewRecipeUser &&
          response.user.loginMethods.length === 1
        ) {
          posthog.capture('user_signed_up', { email: response.user.emails[0] });
        }
        router.replace(redirectToPath ? (redirectToPath as string) : '/');
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
      } else if (response.status === 'EXPIRED_USER_INPUT_CODE_ERROR') {
        toast({
          variant: 'destructive',
          title: 'Code expired',
          description: 'Re-enter your email to get a new code.',
        });
      } else {
        // RESTART_FLOW_ERROR / SIGN_IN_UP_NOT_ALLOWED: send them back to start.
        await clearLoginAttemptInfo();
        toast({
          variant: 'destructive',
          title: 'Error!',
          description: 'Login failed. Please try again.',
        });
        setCode('');
        setEmailSent(false);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      toast({
        variant: 'destructive',
        title: 'Error!',
        description: err.isSuperTokensGeneralError
          ? err.message
          : 'Oops! Something went wrong.',
      });
    }
    setVerifying(false);
  };

  if (emailSent) {
    return (
      <AuthLayout>
        <div className="flex flex-col w-[360px] gap-6">
          <div className="flex flex-col gap-4 items-center">
            <Inbox size={32} />
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
              <ArrowLeft size={14} />
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

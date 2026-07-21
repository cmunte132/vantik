/* eslint-disable react/no-unescaped-entities */
import { zodResolver } from '@hookform/resolvers/zod';
import { RiMailFill } from '@remixicon/react';
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
  const { toast } = useToast();
  const router = useRouter();
  const redirectToPath = router.query.redirectToPath;

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
                        {...field}
                      />
                    </FormControl>

                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex justify-end">
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

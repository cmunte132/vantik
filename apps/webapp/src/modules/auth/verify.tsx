import { Loader } from '@vantikhq/ui/components/loader';
import { useToast } from '@vantikhq/ui/components/use-toast';
import React from 'react';
import { consumeMagicLink } from 'services/auth';

import { useRouter } from 'common/router';
import { safeRedirectPath } from 'common/safe-redirect';
import { AuthGuard } from 'common/wrappers/auth-guard';

export function Verify() {
  const router = useRouter();
  const {
    query: { redirectToPath },
  } = router;
  const { toast } = useToast();

  async function handleMagicLinkClicked() {
    try {
      const preAuthSessionId = router.query.preAuthSessionId as string;
      const linkCode = window.location.hash?.replace(/^#/, '');

      if (!preAuthSessionId || !linkCode) {
        toast({
          title: 'Error!',
          description: 'Invalid magic link. Please try again',
        });
        router.replace('/auth');
        return;
      }

      const response = await consumeMagicLink({
        preAuthSessionId,
        linkCode,
      });

      if (response.status === 'OK') {
        toast({
          title: 'Success!',
          description: 'Sign in successfully!',
        });
        router.replace(safeRedirectPath(redirectToPath));
      } else {
        toast({
          title: 'Error!',
          description: 'Login failed. Please try again',
        });
        router.replace('/auth');
      }
    } catch (err: unknown) {
      toast({
        title: 'Error!',
        description:
          err instanceof Error ? err.message : 'Oops! Something went wrong.',
      });
    }
  }

  React.useEffect(() => {
    handleMagicLinkClicked();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex justify-center items-center w-full">
      <Loader text="Verifying token" />
    </div>
  );
}

Verify.getLayout = function getLayout(page: React.ReactElement) {
  return <AuthGuard>{page}</AuthGuard>;
};

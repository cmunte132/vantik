import React from 'react';

import { useRouter } from 'common/router';
// safeRedirectPath removed
import { doesSessionExist } from 'services/auth';

interface Props {
  children: React.ReactElement;
  onSessionExpired?: () => void;
}

/**
 * SessionAuth wrapper.
 * Ensures active session exists on server; on 401 redirects to /auth.
 */
export function SessionAuth({ children, onSessionExpired }: Props): React.ReactElement {
  const router = useRouter();
  const [checking, setChecking] = React.useState(true);

  React.useEffect(() => {
    let mounted = true;
    doesSessionExist()
      .then((exists) => {
        if (!mounted) return;
        if (!exists) {
          onSessionExpired?.();
          const redirectTo = encodeURIComponent(router.asPath || '/');
          router.replace(`/auth?redirectToPath=${redirectTo}`);
        } else {
          setChecking(false);
        }
      })
      .catch(() => {
        if (!mounted) return;
        onSessionExpired?.();
        router.replace('/auth');
      });

    return () => {
      mounted = false;
    };
  }, [router, onSessionExpired]);

  if (checking) {
    return <div className="h-screen w-screen" />;
  }

  return children;
}

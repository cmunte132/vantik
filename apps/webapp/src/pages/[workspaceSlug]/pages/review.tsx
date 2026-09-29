import { useRouter } from 'next/router';
import * as React from 'react';

/**
 * The old review inbox. Needs you replaced it, and a link kept from before
 * lands there.
 */
export default function Review(): null {
  const router = useRouter();

  React.useEffect(() => {
    if (router.isReady) {
      router.replace({
        pathname: '/[workspaceSlug]/pages/needs-you',
        query: router.query,
      });
    }
  }, [router]);

  return null;
}

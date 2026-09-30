import * as React from 'react';

import { useRouter } from 'common/router';

/** Opens a page by its id. */
export function usePageNavigation() {
  const router = useRouter();
  const { workspaceSlug } = router.query;

  return React.useCallback(
    (pageId: string) => {
      router.push({
        pathname: '/[workspaceSlug]/pages/[pageId]',
        query: { workspaceSlug, pageId },
      });
    },
    [router, workspaceSlug],
  );
}

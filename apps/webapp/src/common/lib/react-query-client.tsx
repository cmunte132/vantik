import { QueryCache, QueryClient } from '@tanstack/react-query';
import * as React from 'react';

import { useRouter } from 'common/router';

export const useGetQueryClient = () => {
  const router = useRouter();

  return React.useRef(
    new QueryClient({
      queryCache: new QueryCache({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onError: (error: any) => {
          if (error?.resStatus === 403) {
            // global intercept 403 and redirect to home page
            router.push('/');
          }
        },
      }),
    }),
  );
};

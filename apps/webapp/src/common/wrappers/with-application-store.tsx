import type { NextLayoutComponentType } from 'next';

import { usePathname } from 'next/navigation';
import { useRouter } from 'next/router';
import React from 'react';

import { readFiltersFromQuery } from 'hooks/use-filter-from-query';

import { useContextStore } from 'store/global-context-provider';

export function withApplicationStore(
  Component: React.ComponentType,
): NextLayoutComponentType {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ComponentWithApplicationStore = (props: any) => {
    const pathname = usePathname();
    const router = useRouter();
    const { applicationStore } = useContextStore();
    const [loading, setLoading] = React.useState(false);

    React.useEffect(() => {
      if (pathname) {
        setLoading(true);
        applicationStore.load(pathname);

        // The address comes second, and it wins. `load` replaces every filter
        // with the ones that local storage holds for this page, so a filter
        // that a link asks for must arrive after it. The parameter then leaves
        // the address, and the filter bar owns the state.
        const { filters, rest } = readFiltersFromQuery(router.query);

        if (Object.keys(filters).length > 0) {
          applicationStore.updateFilters(filters);
          router.replace(
            { pathname: router.pathname, query: rest },
            undefined,
            { shallow: true },
          );
        }

        setLoading(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pathname]);

    if (loading) {
      return null;
    }

    return <Component {...props} />;
  };

  return ComponentWithApplicationStore;
}

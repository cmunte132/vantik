/** Copyright (c) 2024, Vantik, all rights reserved. **/

/**
 * Navigation for the whole app, on React Router.
 *
 * The app was written against the Next.js pages router, and this module keeps
 * that shape: `useRouter()` still has `query`, `pathname`, `push` and
 * `replace`, `Link` still takes an `href`, and a pathname can still be a route
 * pattern such as `/[workspaceSlug]/pages/needs-you` with its parameters in
 * `query`. That is why a call site only changed its import.
 */

import React from 'react';
import {
  type createBrowserRouter,
  Link as RouterLink,
  useLocation,
  useMatches,
  useNavigate,
  useParams as useRouterParams,
} from 'react-router';

/** The query of the current address, as `useRouter().query` returns it. */
export type Query = Record<string, string | string[] | undefined>;

type QueryValue = string | number | boolean;

/** A query to navigate to. Values are turned into strings. */
export type UrlQuery = Record<
  string,
  QueryValue | readonly QueryValue[] | null | undefined
>;

export type Url = string | { pathname?: string; query?: UrlQuery };

type DataRouter = ReturnType<typeof createBrowserRouter>;

export interface NavigateOptions {
  /** Accepted for compatibility. Every navigation is client side already. */
  shallow?: boolean;
  scroll?: boolean;
}

/**
 * A page module's default export. `getLayout` wraps the page in the layout it
 * shares with its neighbours, so the layout stays mounted between them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PageComponent<P = any> = React.ComponentType<P> & {
  getLayout?: (page: React.ReactNode) => React.ReactNode;
};

/** What each page route carries, once its module has loaded. */
export interface PageHandle {
  /** The route as a Next-style pattern, such as `/[workspaceSlug]/all`. */
  pattern: string;
  Page?: PageComponent;
}

/**
 * Turns a string or a `{ pathname, query }` object into a URL. A `[name]` or
 * `[...name]` segment in the pathname takes its value from the query, and the
 * query keys that are left go into the search string.
 */
export function toHref(url: Url): string {
  if (typeof url === 'string') {
    return url;
  }

  const rest: UrlQuery = { ...url.query };
  const pathname = (url.pathname ?? window.location.pathname).replace(
    /\[(\.\.\.)?([^\]]+)\]/g,
    (_segment, spread: string | undefined, name: string) => {
      const value = rest[name];
      delete rest[name];

      if (Array.isArray(value)) {
        return value.map((item) => encodeURIComponent(String(item))).join('/');
      }

      const text = value == null ? '' : String(value);

      return spread
        ? text.split('/').map(encodeURIComponent).join('/')
        : encodeURIComponent(text);
    },
  );

  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(rest)) {
    if (Array.isArray(value)) {
      value.forEach((item) => search.append(key, String(item)));
    } else if (value != null) {
      search.append(key, String(value));
    }
  }

  const searchString = search.toString();

  return searchString ? `${pathname}?${searchString}` : pathname;
}

function parseSearch(search: string): Query {
  const query: Query = {};

  new URLSearchParams(search).forEach((value, key) => {
    const existing = query[key];

    if (existing === undefined) {
      query[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      query[key] = [existing, value];
    }
  });

  return query;
}

let appRouter: DataRouter | undefined;

/** Called once, by main.tsx, with the router it created. */
export function setAppRouter(router: DataRouter) {
  appRouter = router;
}

function navigate(url: Url, replace: boolean): Promise<boolean> {
  const href = toHref(url);

  if (!appRouter) {
    if (replace) {
      window.location.replace(href);
    } else {
      window.location.assign(href);
    }

    return Promise.resolve(true);
  }

  return appRouter.navigate(href, { replace }).then(() => true);
}

/** For code outside React. */
export const Router = {
  push: (url: Url) => navigate(url, false),
  replace: (url: Url) => navigate(url, true),
};

export interface AppRouter {
  /** The route parameters and the search parameters, in one object. */
  query: Query;
  /** The route pattern, such as `/[workspaceSlug]/issue/[issueId]`. */
  pathname: string;
  /** The path in the address bar, with its search string. */
  asPath: string;
  /** Always true: there is no server render to wait for. */
  isReady: true;
  push: (url: Url, as?: unknown, options?: NavigateOptions) => Promise<boolean>;
  replace: (
    url: Url,
    as?: unknown,
    options?: NavigateOptions,
  ) => Promise<boolean>;
  back: () => void;
}

export function useRouter(): AppRouter {
  const location = useLocation();
  const params = useRouterParams();
  const matches = useMatches();
  const routerNavigate = useNavigate();

  const pattern =
    (matches[matches.length - 1]?.handle as PageHandle | undefined)?.pattern ??
    location.pathname;
  const paramsKey = JSON.stringify(params);

  return React.useMemo(
    () => ({
      query: { ...parseSearch(location.search), ...params },
      pathname: pattern,
      asPath: `${location.pathname}${location.search}`,
      isReady: true,
      push: (url: Url) =>
        Promise.resolve(routerNavigate(toHref(url))).then(() => true),
      replace: (url: Url) =>
        Promise.resolve(routerNavigate(toHref(url), { replace: true })).then(
          () => true,
        ),
      back: () => {
        void routerNavigate(-1);
      },
    }),
    // `params` is a new object on every render; its contents are the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [location.pathname, location.search, paramsKey, pattern, routerNavigate],
  );
}

/** The path in the address bar, without the search string. */
export function usePathname(): string {
  return useLocation().pathname;
}

export function useParams<
  T extends Record<string, string | string[] | undefined> = Record<
    string,
    string
  >,
>(): T {
  return useRouterParams() as T;
}

export type LinkProps = Omit<
  React.ComponentProps<typeof RouterLink>,
  'to' | 'href'
> & {
  href: Url;
};

export function Link({ href, ...rest }: LinkProps) {
  return <RouterLink to={toHref(href)} {...rest} />;
}

export default Link;

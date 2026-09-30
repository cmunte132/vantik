/** Copyright (c) 2024, Vantik, all rights reserved. **/

import type { RouteObject } from 'react-router';

import type { PageComponent, PageHandle } from 'common/router';

import { App, AppError, NotFound } from './app';

/**
 * Every page is a file under src/pages, as it was under Next, and its path is
 * the route: `pages/[workspaceSlug]/issue/[issueId].tsx` serves
 * `/:workspaceSlug/issue/:issueId`. Each one loads on first visit.
 */
const pageModules = import.meta.glob<{ default: PageComponent }>(
  './pages/**/*.tsx',
);

/** `./pages/[workspaceSlug]/issue/[issueId].tsx` → `/[workspaceSlug]/issue/[issueId]` */
function patternOf(file: string): string {
  const pattern = file
    .replace(/^\.\/pages/, '')
    .replace(/\.tsx$/, '')
    .replace(/\/index$/, '');

  return pattern || '/';
}

/** `/[workspaceSlug]/issue/[issueId]` → `/:workspaceSlug/issue/:issueId` */
function pathOf(pattern: string): string {
  return pattern
    .replace(/\[\.\.\.[^\]]+\]/g, '*')
    .replace(/\[([^\]]+)\]/g, ':$1');
}

const pageRoutes: RouteObject[] = Object.entries(pageModules).map(
  ([file, load]) => {
    const pattern = patternOf(file);

    return {
      path: pathOf(pattern),
      // The whole handle comes from lazy. React Router ignores what lazy
      // returns for a key the route already sets, so the route sets none.
      lazy: async () => {
        const { default: Page } = await load();

        return { handle: { pattern, Page } satisfies PageHandle };
      },
    };
  },
);

export const routes: RouteObject[] = [
  {
    // Renders the page itself, inside its layout, so that a layout two pages
    // share stays mounted between them. See App.
    Component: App,
    ErrorBoundary: AppError,
    // The first page's chunk is still loading. The document is blank until
    // then anyway, as it was under Next before hydration.
    HydrateFallback: () => null,
    children: [
      ...pageRoutes,
      { path: '*', handle: { pattern: '*', Page: NotFound } },
    ],
  },
];

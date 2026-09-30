/** Copyright (c) 2024, Vantik, all rights reserved. **/

import { QueryClientProvider } from '@tanstack/react-query';
import { Button } from '@vantikhq/ui/components/button';
import { ThemeProvider } from '@vantikhq/ui/components/theme-provider';
import { Toaster } from '@vantikhq/ui/components/toaster';
import { TooltipProvider } from '@vantikhq/ui/components/tooltip';
import * as Sentry from '@sentry/react';
import posthog from 'posthog-js';
import { PostHogProvider } from 'posthog-js/react';
import React from 'react';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { useMatches, useRouteError } from 'react-router';

import { useGetQueryClient } from 'common/lib/react-query-client';
import { recoverIfStaleChunk } from 'common/lib/stale-chunk-recovery';
import type { PageHandle } from 'common/router';
import { SCOPES } from 'common/scopes';
import { AppVersionProvider } from 'common/wrappers/app-version-provider';

import { UnsentChangesChip } from 'components/unsent-changes-chip';
import { UpdateAvailableChip } from 'components/update-available-chip';

import { StoreContext, storeContextStore } from 'store/global-context-provider';

/**
 * The page the address points at, inside its layout.
 *
 * It is one component for every route, and that is the point: when two pages
 * share a layout, the layout is the same element type at the same place in the
 * tree, so React keeps it mounted and only the page inside it changes. A route
 * per page, each rendering its own layout, would remount the sidebar and every
 * store subscription under it on each navigation.
 */
function CurrentPage() {
  const matches = useMatches();
  const handle = matches[matches.length - 1]?.handle as PageHandle | undefined;
  const Page = handle?.Page;

  if (!Page) {
    return null;
  }

  const getLayout = Page.getLayout ?? ((page: React.ReactNode) => page);

  return <>{getLayout(<Page />)}</>;
}

export function App() {
  const queryClientRef = useGetQueryClient();

  return (
    <>
      <PostHogProvider client={posthog}>
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem
          disableTransitionOnChange
        >
          <HotkeysProvider initiallyActiveScopes={[SCOPES.Global]}>
            <TooltipProvider delayDuration={500}>
              <StoreContext.Provider value={storeContextStore}>
                <QueryClientProvider client={queryClientRef.current}>
                  {/*
                    Above the routes and outside any auth guard: a client can
                    be stale on the login screen too, and the stale-chunk
                    recovery it installs has to be in place before the first
                    navigation.
                  */}
                  <AppVersionProvider>
                    <div className="min-h-screen font-sans antialiased flex">
                      <CurrentPage />
                    </div>

                    <Toaster />
                    <UpdateAvailableChip />
                    <UnsentChangesChip />
                  </AppVersionProvider>
                </QueryClientProvider>
              </StoreContext.Provider>
            </TooltipProvider>
          </HotkeysProvider>
        </ThemeProvider>
      </PostHogProvider>
    </>
  );
}

function ErrorScreen({ title, message }: { title: string; message: string }) {
  return (
    <div className="h-[100vh] w-[100vw] flex justify-center items-center flex-col">
      <h1>{title}</h1>
      <p>{message}</p>
      <Button
        variant="secondary"
        className="mt-2"
        onClick={() => window.location.reload()}
      >
        Reload page
      </Button>
    </div>
  );
}

export function NotFound() {
  return <ErrorScreen title="Error 404" message="Page not found" />;
}

/** What a route shows when it throws while it loads or renders. */
export function AppError() {
  const error = useRouteError();

  React.useEffect(() => {
    // A page chunk from a build that has been replaced. Reloading fixes it, so
    // it is not an error worth reporting.
    if (!recoverIfStaleChunk(error)) {
      Sentry.captureException(error);
    }
  }, [error]);

  return (
    <ErrorScreen
      title="An error occurred"
      message="Something went wrong on our end. Please try again later."
    />
  );
}

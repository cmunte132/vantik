import './global.css';
import '@vantikhq/ui/index.css';
import '@vantikhq/ui/global.css';
import type { NextComponentType } from 'next';
import type { AppContext, AppInitialProps, AppLayoutProps } from 'next/app';

import { ThemeProvider } from '@vantikhq/ui/components/theme-provider';
import { Toaster } from '@vantikhq/ui/components/toaster';
import { TooltipProvider } from '@vantikhq/ui/components/tooltip';
import { cn } from '@vantikhq/ui/lib/utils';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import React from 'react';

import { SiteHeader } from 'layouts/main';
import { SiteFooter } from 'layouts/main/site-footer';

export const MyApp: NextComponentType<
  AppContext,
  AppInitialProps,
  AppLayoutProps
> = ({ Component, pageProps }: AppLayoutProps) => {
  const getLayout = Component.getLayout || ((page: React.ReactNode) => page);

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="light"
      enableSystem
      disableTransitionOnChange
    >
      <TooltipProvider delayDuration={1000}>
        <div
          className={cn(
            'relative flex min-h-screen flex-col bg-background',
            GeistSans.variable,
            GeistMono.variable,
          )}
        >
          <SiteHeader />
          <main className="flex-1">
            {getLayout(<Component {...pageProps} />)}
          </main>
          <SiteFooter />
        </div>

        <Toaster />
      </TooltipProvider>
    </ThemeProvider>
  );
};

export default MyApp;

/** Copyright (c) 2024, Vantik, all rights reserved. **/

import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './global.css';
import '@vantikhq/ui/global.css';

import TimeAgo from 'javascript-time-ago';
import en from 'javascript-time-ago/locale/en';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';

import { initPosthog, initSentry } from 'common/init-config';
import { setAppRouter } from 'common/router';

import { routes } from './routes';

void initSentry();
// Analytics config is fetched, so this settles a beat after the app mounts.
void initPosthog();

TimeAgo.addDefaultLocale(en);

const router = createBrowserRouter(routes);
setAppRouter(router);

// No StrictMode, as under Next (reactStrictMode: false). Its double-run effects
// in development would open two sockets and run each bootstrap twice.
createRoot(document.getElementById('root') as HTMLElement).render(
  <RouterProvider router={router} />,
);

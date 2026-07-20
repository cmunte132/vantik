import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import { Html, Head, Main, NextScript } from 'next/document';

export default function Document() {
  return (
    <Html lang="en" className={`${GeistMono.variable} ${GeistSans.variable}`}>
      <Head>
        {/* PWA: installable, standalone launch */}
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content="#1a89c5" />
        <meta name="application-name" content="Vantik" />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" type="image/png" href="/icon-192.png" sizes="192x192" />
        {/* iOS: no manifest install support, needs these for Add to Home Screen */}
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="Vantik" />
        <meta name="mobile-web-app-capable" content="yes" />
      </Head>
      <body className="font-sans">
        <Main />
        <NextScript />
        {/*
          Register the service worker so browsers offer to install Vantik as a
          PWA. Done here (not in a React effect) so it runs on raw HTML load,
          independent of React hydration. The worker only enables the install
          prompt; it does no caching.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})});}",
          }}
        />
      </body>
    </Html>
  );
}

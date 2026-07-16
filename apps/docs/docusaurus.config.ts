import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
  title: 'Vantik',
  tagline: 'A dev-first, agent-native issue tracker.',
  favicon: 'img/favicon.svg',

  future: {
    v4: true,
  },

  // Since vantik.dev is registered, this is set up for a custom domain via
  // GitHub Pages. To go live: add a CNAME file (see static/CNAME) and point
  // vantik.dev's DNS at GitHub Pages per
  // https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site
  // Until DNS is configured, GitHub will still serve this at
  // https://cmunte132.github.io/vantik/ - if you want that instead, change
  // url below to that and set baseUrl to '/vantik/'.
  url: 'https://vantik.dev',
  baseUrl: '/',

  organizationName: 'cmunte132',
  projectName: 'vantik',
  trailingSlash: false,

  onBrokenLinks: 'warn',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/cmunte132/vantik/tree/main/apps/docs/',
          routeBasePath: 'docs',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  plugins: [
    [
      'docusaurus-plugin-openapi-docs',
      {
        id: 'api',
        docsPluginId: 'classic',
        config: {
          vantik: {
            specPath: 'openapi/openapi.yml',
            outputDir: 'docs/api-reference',
            sidebarOptions: {
              groupPathsBy: 'tag',
            },
          },
        },
      },
    ],
  ],

  themes: ['docusaurus-theme-openapi-docs'],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'Vantik',
      logo: {
        alt: 'Vantik logo',
        src: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          type: 'docSidebar',
          sidebarId: 'apiSidebar',
          position: 'left',
          label: 'API Reference',
        },
        {
          href: 'https://github.com/cmunte132/vantik',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {label: 'Introduction', to: '/docs/introduction'},
            {label: 'Quickstart', to: '/docs/quickstart'},
            {label: 'API Reference', to: '/docs/api-reference/overview'},
          ],
        },
        {
          title: 'Project',
          items: [
            {label: 'GitHub', href: 'https://github.com/cmunte132/vantik'},
            {
              label: 'Original project (RedPlanetHQ/tegon)',
              href: 'https://github.com/RedPlanetHQ/tegon',
            },
          ],
        },
      ],
      copyright: `Vantik is a fork of RedPlanetHQ/tegon, licensed AGPL-3.0. © ${new Date().getFullYear()}.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;

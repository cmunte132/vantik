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

  // GitHub Pages serves this site at docs.vantik.dev. The deploy uses GitHub
  // Actions, so GitHub ignores static/CNAME: set the custom domain in the
  // repository's Pages settings. The marketing site at vantik.dev is
  // apps/landing, on Cloudflare Pages.
  url: 'https://docs.vantik.dev',
  baseUrl: '/',

  organizationName: 'cmunte132',
  projectName: 'vantik',
  trailingSlash: false,

  onBrokenLinks: 'warn',
  markdown: {
    mermaid: true,
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
          routeBasePath: '/',
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

  themes: ['docusaurus-theme-openapi-docs', '@docusaurus/theme-mermaid'],

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
          href: 'https://vantik.dev',
          label: 'Home',
          position: 'right',
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
            {label: 'Introduction', to: '/'},
            {label: 'Quickstart', to: '/quickstart'},
            {label: 'API Reference', to: '/api-reference/overview'},
          ],
        },
        {
          title: 'Project',
          items: [
            {label: 'GitHub', href: 'https://github.com/cmunte132/vantik'},
            {
              label: 'Original project (RedPlanetHQ/tegon, archived)',
              href: 'https://github.com/RedPlanetHQ/tegon',
            },
          ],
        },
      ],
      copyright: `Vantik continues RedPlanetHQ/tegon, which is archived. Licensed AGPL-3.0. © ${new Date().getFullYear()}.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;

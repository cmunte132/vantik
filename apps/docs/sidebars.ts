import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';
import apiSidebar from './docs/api-reference/sidebar';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    {
      type: 'category',
      label: 'Get Started',
      items: ['introduction', 'quickstart', 'concepts', 'changelog'],
    },
    {
      type: 'category',
      label: 'Fundamentals',
      items: [
        'fundamentals/issues',
        'fundamentals/triage',
        'fundamentals/cycles',
        'fundamentals/projects',
        'fundamentals/product-axis',
        'fundamentals/views',
        'fundamentals/inbox',
        'fundamentals/my-issues',
        'fundamentals/definition-of-done',
        'fundamentals/sub-issues-and-relations',
        'fundamentals/templates',
        'fundamentals/search',
        'fundamentals/shortcuts',
        {
          type: 'category',
          label: 'Knowledge',
          link: { type: 'doc', id: 'fundamentals/knowledge' },
          items: [
            'fundamentals/knowledge/needs-you',
            'fundamentals/knowledge/gardener',
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'Agents',
      items: [
        'agents/delegating-an-issue',
        'agents/running-on-your-machine',
        'agents/review-cycle',
      ],
    },
    {
      type: 'category',
      label: 'Developers',
      items: [
        {type: 'doc', id: 'developers/connect-mcp', label: 'How to connect an MCP client'},
        {type: 'doc', id: 'developers/agents', label: 'How to work with agents'},
        {type: 'doc', id: 'developers/cli', label: 'CLI reference'},
      ],
    },
    {
      type: 'category',
      label: 'Settings',
      items: [
        'settings/account',
        'settings/workspace',
        'settings/agents',
        'settings/team',
      ],
    },
    {
      type: 'category',
      label: 'Integrations',
      items: [
        'integrations/overview',
        'integrations/github',
        'integrations/git-hosts',
        'integrations/local-repositories',
        'integrations/email',
        'integrations/discord',
        'integrations/bug-enricher',
      ],
    },
    {
      type: 'category',
      label: 'Open Source',
      items: [
        'oss/local-setup',
        'oss/self-deployment',
        'oss/agent-sandbox',
        'oss/contributing',
      ],
    },
  ],
  // docusaurus-plugin-openapi-docs makes the other entries. The commands are
  // `pnpm clean-api-docs && pnpm gen-api-docs`. Do not edit
  // docs/api-reference/sidebar.ts by hand, because these commands replace the
  // file each time that they run. A person wrote one page,
  // 'api-reference/overview'. If the commands remove it, put it here again.
  // Guides that are not about the API go in the Developers category above.
  apiSidebar: [
    {type: 'doc', id: 'api-reference/overview', label: 'Overview and authentication'},
    ...apiSidebar,
  ],
};

export default sidebars;

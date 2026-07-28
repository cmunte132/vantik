import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';
import apiSidebar from './docs/api-reference/sidebar';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    {
      type: 'category',
      label: 'Get Started',
      items: ['introduction', 'quickstart', 'changelog'],
    },
    {
      type: 'category',
      label: 'Fundamentals',
      items: [
        'fundamentals/issues',
        'fundamentals/triage',
        'fundamentals/cycles',
        'fundamentals/projects',
        'fundamentals/views',
        'fundamentals/actions',
      ],
    },
    {
      type: 'category',
      label: 'Actions',
      items: [
        'actions/overview',
        'actions/core-concepts',
        'actions/config',
        {
          type: 'category',
          label: 'Marketplace',
          items: [
            'actions/marketplace/overview',
            'actions/marketplace/bug-enricher',
            'actions/marketplace/email-actions',
            'actions/marketplace/issue-view-summary',
          ],
        },
        {
          type: 'category',
          label: 'How to write an action',
          items: [
            'actions/writing-action/introduction',
            'actions/writing-action/general-example',
            'actions/writing-action/bug-enricher-example',
            'actions/writing-action/scheduled-actions',
          ],
        },
      ],
    },
    {
      type: 'category',
      label: 'Integrations',
      items: [
        'integrations/overview',
        'integrations/github',
        'integrations/contribute',
      ],
    },
    {
      type: 'category',
      label: 'Open Source',
      items: [
        'oss/local-setup',
        'oss/self-deployment',
        'oss/contributing',
      ],
    },
  ],
  // docusaurus-plugin-openapi-docs makes the other entries. The command is
  // `npm run gen-api-docs vantik`. Do not edit docs/api-reference/sidebar.ts by
  // hand, because that command replaces the file each time that it runs. A
  // person wrote these three pages: 'api-reference/overview',
  // 'api-reference/connect-mcp', and 'api-reference/agents'. If the command
  // removes them, put them here again.
  apiSidebar: [
    {type: 'doc', id: 'api-reference/overview', label: 'Overview and authentication'},
    {type: 'doc', id: 'api-reference/connect-mcp', label: 'How to connect an MCP client'},
    {type: 'doc', id: 'api-reference/agents', label: 'How to work with agents'},
    ...apiSidebar,
  ],
};

export default sidebars;

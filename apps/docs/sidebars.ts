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
          label: 'Writing an Action',
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
  // Auto-generated entries come from docusaurus-plugin-openapi-docs
  // (npm run gen-api-docs vantik) - don't hand-edit docs/api-reference/sidebar.ts,
  // it's overwritten every time that command runs. 'api-reference/overview' and
  // 'api-reference/agents' are the hand-written pages in this section and need
  // re-adding here if they ever get wiped out by a regen.
  apiSidebar: [
    {type: 'doc', id: 'api-reference/overview', label: 'Overview & Authentication'},
    {type: 'doc', id: 'api-reference/agents', label: 'Working with agents'},
    ...apiSidebar,
  ],
};

export default sidebars;

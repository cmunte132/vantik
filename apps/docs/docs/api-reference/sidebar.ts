import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebar: SidebarsConfig = {
  apisidebar: [
    {
      type: "doc",
      id: "api-reference/vantik",
    },
    {
      type: "category",
      label: "Integration_definition",
      items: [
        {
          type: "doc",
          id: "api-reference/get-integration-definition-by-id",
          label: "Get integration definition by ID",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/get-integration-definitions-by-workspace-id",
          label: "Get integration definitions by workspace ID",
          className: "api-method get",
        },
      ],
    },
    {
      type: "category",
      label: "Issue_comments",
      items: [
        {
          type: "doc",
          id: "api-reference/create-an-issue-comment",
          label: "Create an issue comment",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/delete-issue-comment",
          label: "Delete issue comment",
          className: "api-method delete",
        },
        {
          type: "doc",
          id: "api-reference/update-issue-comment",
          label: "Update issue comment",
          className: "api-method post",
        },
      ],
    },
    {
      type: "category",
      label: "Issue_relation",
      items: [
        {
          type: "doc",
          id: "api-reference/delete-issue-relation",
          label: "Delete issue relation",
          className: "api-method delete",
        },
      ],
    },
    {
      type: "category",
      label: "Issue",
      items: [
        {
          type: "doc",
          id: "api-reference/create-issue",
          label: "Create issue",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/get-issue",
          label: "Get issue",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/update-issue",
          label: "Update issue",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/delete-issue",
          label: "Delete issue",
          className: "api-method delete",
        },
        {
          type: "doc",
          id: "api-reference/get-issues-by-filter",
          label: "Get issues by filter",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/move-issue-to-team",
          label: "Move issue to team",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/get-issue-by-number",
          label: "Get issue by number",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/get-issue-context",
          label: "Get issue context",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/export-issues-as-csv",
          label: "Export issues as CSV",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/subscribe-to-issue",
          label: "Subscribe to issue",
          className: "api-method post",
        },
      ],
    },
    {
      type: "category",
      label: "Product",
      items: [
        {
          type: "doc",
          id: "api-reference/list-products",
          label: "List products",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/create-product",
          label: "Create product",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/update-product",
          label: "Update product",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/delete-product",
          label: "Delete product",
          className: "api-method delete",
        },
      ],
    },
    {
      type: "category",
      label: "Module",
      items: [
        {
          type: "doc",
          id: "api-reference/list-modules",
          label: "List modules",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/create-module",
          label: "Create module",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/list-the-repositories-that-modules-can-use",
          label: "List the repositories that modules can use",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/update-module",
          label: "Update module",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/delete-module",
          label: "Delete module",
          className: "api-method delete",
        },
        {
          type: "doc",
          id: "api-reference/list-the-repositories-of-a-module",
          label: "List the repositories of a module",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/point-a-module-at-a-repository",
          label: "Point a module at a repository",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/update-a-module-repository",
          label: "Update a module repository",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/unpoint-a-module-from-a-repository",
          label: "Unpoint a module from a repository",
          className: "api-method delete",
        },
        {
          type: "doc",
          id: "api-reference/list-the-folders-of-a-module-repository",
          label: "List the folders of a module repository",
          className: "api-method get",
        },
      ],
    },
    {
      type: "category",
      label: "Capability",
      items: [
        {
          type: "doc",
          id: "api-reference/list-capabilities",
          label: "List capabilities",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/create-capability",
          label: "Create capability",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/update-capability",
          label: "Update capability",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/delete-capability",
          label: "Delete capability",
          className: "api-method delete",
        },
      ],
    },
    {
      type: "category",
      label: "Labels",
      items: [
        {
          type: "doc",
          id: "api-reference/get-labels",
          label: "Get labels",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/create-label",
          label: "Create label",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/update-label",
          label: "Update label",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/delete-label",
          label: "Delete label",
          className: "api-method delete",
        },
      ],
    },
    {
      type: "category",
      label: "Users",
      items: [
        {
          type: "doc",
          id: "api-reference/create-personal-access-token-pat",
          label: "Create personal access token (PAT)",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/list-personal-access-tokens-pat",
          label: "List personal access tokens (PAT)",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/create-agent-account",
          label: "Create agent account",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/list-agent-accounts",
          label: "List agent accounts",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/clear-revoked-agents",
          label: "Clear revoked agents",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/revoke-agent-account",
          label: "Revoke agent account",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/delete-personal-access-token-pat",
          label: "Delete personal access token (PAT)",
          className: "api-method delete",
        },
        {
          type: "doc",
          id: "api-reference/get-user",
          label: "Get user",
          className: "api-method get",
        },
      ],
    },
    {
      type: "category",
      label: "Teams",
      items: [
        {
          type: "doc",
          id: "api-reference/get-workflows",
          label: "Get workflows",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/list-teams",
          label: "List teams",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/create-team",
          label: "Create team",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/update-team",
          label: "Update team",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/delete-team",
          label: "Delete team",
          className: "api-method delete",
        },
        {
          type: "doc",
          id: "api-reference/update-team-preferences",
          label: "Update team preferences",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/list-team-members",
          label: "List team members",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/add-team-member",
          label: "Add team member",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/remove-team-member",
          label: "Remove team member",
          className: "api-method post",
        },
      ],
    },
    {
      type: "category",
      label: "Definition of Done",
      items: [
        {
          type: "doc",
          id: "api-reference/list-definition-of-done-criteria",
          label: "List Definition of Done criteria",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/add-definition-of-done-criterion",
          label: "Add Definition of Done criterion",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/update-definition-of-done-criterion",
          label: "Update Definition of Done criterion",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/delete-definition-of-done-criterion",
          label: "Delete Definition of Done criterion",
          className: "api-method delete",
        },
      ],
    },
    {
      type: "category",
      label: "Agent_runs",
      items: [
        {
          type: "doc",
          id: "api-reference/list-agent-runs",
          label: "List agent runs",
          className: "api-method get",
        },
      ],
    },
    {
      type: "category",
      label: "Pages",
      items: [
        {
          type: "doc",
          id: "api-reference/list-pages",
          label: "List pages",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/create-page",
          label: "Create page",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/list-pages-linked-to-an-entity",
          label: "List pages linked to an entity",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/get-page",
          label: "Get page",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/update-page",
          label: "Update page",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/delete-page",
          label: "Delete page",
          className: "api-method delete",
        },
        {
          type: "doc",
          id: "api-reference/list-issues-that-mention-a-page",
          label: "List issues that mention a page",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/list-page-links",
          label: "List page links",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/create-page-link",
          label: "Create page link",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/delete-page-link",
          label: "Delete page link",
          className: "api-method delete",
        },
        {
          type: "doc",
          id: "api-reference/get-page-history",
          label: "Get page history",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/revert-page-body",
          label: "Revert page body",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/propose-page-consolidation",
          label: "Propose page consolidation",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/list-page-proposals",
          label: "List page proposals",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/accept-page-proposal",
          label: "Accept page proposal",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/decline-page-proposal",
          label: "Decline page proposal",
          className: "api-method post",
        },
      ],
    },
    {
      type: "category",
      label: "Page_entries",
      items: [
        {
          type: "doc",
          id: "api-reference/list-page-entries",
          label: "List page entries",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/create-page-entry",
          label: "Create page entry",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/triage-page-entries-in-bulk",
          label: "Triage page entries in bulk",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/move-page-entries",
          label: "Move page entries",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/update-page-entry",
          label: "Update page entry",
          className: "api-method post",
        },
      ],
    },
    {
      type: "category",
      label: "Knowledge",
      items: [
        {
          type: "doc",
          id: "api-reference/search-knowledge",
          label: "Search knowledge",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/load-a-context-pack",
          label: "Load a context pack",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/find-similar-knowledge-entries",
          label: "Find similar knowledge entries",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/list-knowledge-gaps",
          label: "List knowledge gaps",
          className: "api-method get",
        },
      ],
    },
    {
      type: "category",
      label: "Project",
      items: [
        {
          type: "doc",
          id: "api-reference/list-projects",
          label: "List projects",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/create-project",
          label: "Create project",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/update-project",
          label: "Update project",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/delete-project",
          label: "Delete project",
          className: "api-method delete",
        },
        {
          type: "doc",
          id: "api-reference/create-project-milestone",
          label: "Create project milestone",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/update-project-milestone",
          label: "Update project milestone",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/delete-project-milestone",
          label: "Delete project milestone",
          className: "api-method delete",
        },
      ],
    },
    {
      type: "category",
      label: "Search",
      items: [
        {
          type: "doc",
          id: "api-reference/search-issues",
          label: "Search issues",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/find-similar-issues",
          label: "Find similar issues",
          className: "api-method get",
        },
      ],
    },
  ],
};

export default sidebar.apisidebar;

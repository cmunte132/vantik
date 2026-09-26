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
      ],
    },
  ],
};

export default sidebar.apisidebar;

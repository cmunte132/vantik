import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebar: SidebarsConfig = {
  apisidebar: [
    {
      type: "doc",
      id: "api-reference/vantik",
    },
    {
      type: "category",
      label: "Action",
      items: [
        {
          type: "doc",
          id: "api-reference/run-an-action",
          label: "Run an action",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/update-action-inputs",
          label: "Update action inputs",
          className: "api-method post",
        },
      ],
    },
    {
      type: "category",
      label: "Ai_requests",
      items: [
        {
          type: "doc",
          id: "api-reference/get-ai-request",
          label: "Get AI request",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/get-ai-request-stream",
          label: "Get AI request stream",
          className: "api-method post",
        },
      ],
    },
    {
      type: "category",
      label: "Integration_account",
      items: [
        {
          type: "doc",
          id: "api-reference/get-integration-accounts-by-integration-account-id",
          label: "Get integration accounts by integration account ID",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/get-integration-accounts-by-account-id",
          label: "Get integration accounts by account ID",
          className: "api-method get",
        },
      ],
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
          id: "api-reference/create-a-linked-comment",
          label: "Create a linked comment",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/get-issue-comment",
          label: "Get issue comment",
          className: "api-method get",
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
        {
          type: "doc",
          id: "api-reference/create-linked-issue",
          label: "Create linked issue",
          className: "api-method post",
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
      label: "Linked_issue",
      items: [
        {
          type: "doc",
          id: "api-reference/get-linked-issue-by-id",
          label: "Get linked issue by ID",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/update-linked-issue-by-id",
          label: "Update linked issue by ID",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/delete-linked-issue",
          label: "Delete linked issue",
          className: "api-method delete",
        },
        {
          type: "doc",
          id: "api-reference/get-linked-issue-by-source-id",
          label: "Get linked issue by source ID",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/get-personal-access-tokens-pa-ts",
          label: "Get personal access tokens (PATs)",
          className: "api-method get",
        },
        {
          type: "doc",
          id: "api-reference/update-linked-issue-by-source-id",
          label: "Update linked issue by source ID",
          className: "api-method post",
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
        {
          type: "doc",
          id: "api-reference/get-users",
          label: "Get users",
          className: "api-method post",
        },
        {
          type: "doc",
          id: "api-reference/get-view",
          label: "Get view",
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

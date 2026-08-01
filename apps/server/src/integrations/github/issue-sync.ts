import { RoleEnum, WorkflowCategory } from '@vantikhq/types';
import { type PluginContext } from 'plugins/plugin.interface';

import { GITHUB_HEADERS } from './plugin-spec';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * A Vantik issue, pushed out to GitHub — created there, or updated in place.
 *
 * Ported from `actions/github/triggers/issue-sync.ts`. Two things the original
 * did through side doors are now capabilities.
 *
 * It read the assignee's personal GitHub account by calling
 * `/api/v1/integration_account/personal` over HTTP, through an axios instance
 * carrying the caller's Vantik access token — the plugin reaching back into the
 * API it is part of. That is `ctx.account.personal` now.
 *
 * And it picked between `accessToken` and `botToken` itself. It asks for an
 * identity instead; the host resolves the token.
 */
export async function issueSync(ctx: PluginContext, payload: Json) {
  const account = payload.integrationAccounts?.github;

  if (!account || !payload.modelId) {
    return { message: 'No GitHub account for this workspace' };
  }

  const slug = account.integrationDefinition?.slug;
  const issue = await ctx.issues.get(payload.modelId);

  const users = await ctx.workspace.users();
  const actor = users.find(
    (member: Json) =>
      member.userId === (issue.updatedById || issue.createdById),
  );

  // Our own sync writes issues too, and mirroring those back out is a loop.
  if (actor?.role === RoleEnum.BOT) {
    return { message: 'Ignoring an issue written by a bot' };
  }

  const mapping = payload.action?.data?.inputs?.repoTeamMappings?.find(
    ({ teamId }: { teamId: string }) => teamId === issue.teamId,
  );

  if (!mapping) {
    ctx.log.debug(`Team ${issue.teamId} is not mapped to a repository`);

    return undefined;
  }

  const repoFullName = account.settings?.repositories?.find(
    (repo: Json) => repo.id === mapping.repo,
  )?.fullName;

  const workflows = await ctx.workspace.workflows(issue.teamId);
  const category = workflows.find(
    (workflow: Json) => workflow.id === issue.stateId,
  )?.category;

  const assigneeAccount = issue.assigneeId
    ? await ctx.account.personal(slug, issue.team.workspaceId, issue.assigneeId)
    : null;

  const labels = await ctx.workspace.labels();
  const named = issue.labelIds
    .map((id: string) => labels.find((label: Json) => label.id === id)?.name)
    .filter(Boolean);

  const body: Json = {
    title: issue.title,
    ...(issue.description ? { body: issue.descriptionMarkdown } : {}),
    labels: [...named, 'Vantik'],
    state:
      category === WorkflowCategory.COMPLETED ||
      category === WorkflowCategory.CANCELED
        ? 'closed'
        : 'open',
    state_reason:
      category === WorkflowCategory.COMPLETED
        ? 'completed'
        : category === WorkflowCategory.CANCELED
          ? 'not_planned'
          : null,
  };

  if (assigneeAccount) {
    body.assignees = [assigneeAccount.settings?.login];
  }

  // Already linked: update the GitHub issue in place, at the absolute URL it
  // gave us when the link was made.
  if (payload.linkedIssue) {
    const apiUrl = (payload.linkedIssue.sourceData as Record<string, string>)
      ?.apiUrl;

    const response = await ctx.vendor.fetch(apiUrl, {
      method: 'POST',
      as: assigneeAccount ? 'user' : 'bot',
      headers: { ...GITHUB_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    return response.ok ? await response.json() : null;
  }

  const created = await ctx.vendor.fetch(`/repos/${repoFullName}/issues`, {
    method: 'POST',
    as: 'bot',
    headers: { ...GITHUB_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!created.ok) {
    ctx.log.error(`GitHub refused the new issue: ${created.status}`);

    return { message: `GitHub refused the issue (${created.status})` };
  }

  const githubIssue = await created.json();

  const linkIssueData = {
    url: githubIssue.html_url,
    sourceId: String(githubIssue.id),
    sourceData: {
      id: String(githubIssue.id),
      issueNumber: githubIssue.number,
      title: `#${githubIssue.number} - ${githubIssue.title}`,
      apiUrl: githubIssue.url,
      htmlUrl: githubIssue.html_url,
      commentApiUrl: githubIssue.comments_url,
      type: slug,
      displayName: githubIssue.user?.login,
      githubType: 'ISSUE',
    },
    createdById: payload.userId,
  };

  await ctx.issues.update(issue.id, issue.teamId, { linkIssueData });

  return githubIssue;
}

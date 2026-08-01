import { RoleEnum } from '@vantikhq/types';
import { type PluginContext } from 'plugins/plugin.interface';

import { GITHUB_HEADERS } from './plugin-spec';

/**
 * A comment written in Vantik, mirrored onto the GitHub issue or pull request.
 *
 * Ported from `actions/github/triggers/comment-sync.ts`. The behaviour is
 * unchanged; what changed is that the credential is no longer read here.
 *
 * The identity is the interesting part. A comment goes out as the *person* when
 * they have connected their own GitHub account, and as the installation bot
 * when they have not — and in the second case it is prefixed with who said it,
 * because otherwise a thread of everybody's replies arrives under one robot's
 * name. The plugin asks for `user` or `bot`; the host turns that into a token.
 */
export async function commentSync(ctx: PluginContext, payload: Json) {
  const account = payload.integrationAccounts?.github;
  const issueCommentId = payload.modelId;

  if (!account || !issueCommentId) {
    return { message: 'No GitHub account for this workspace' };
  }

  const slug = account.integrationDefinition?.slug;

  const issueComment = await ctx.comments.get(issueCommentId);
  const issue = await ctx.issues.get(issueComment.issueId);

  const users = await ctx.workspace.users();
  const author = users.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (member: any) => member.userId === issueComment.updatedById,
  );

  // Our own sync writes comments too. Without this a comment arriving from
  // GitHub is mirrored straight back to GitHub.
  if (author?.role === RoleEnum.BOT) {
    return { message: 'Ignoring a comment written by a bot' };
  }

  const parent = issueComment.parent;
  const parentSource = (parent?.sourceMetadata ?? {}) as Record<string, string>;

  // Only a reply to something that came *from* GitHub syncs back to it. A
  // top-level comment on a Vantik issue has nowhere to go.
  if (!parent || parentSource.type !== slug) {
    return { message: 'Parent comment did not come from GitHub' };
  }

  const links = await ctx.links.forIssue(issueComment.issueId);
  const syncing = links.find((link: { sourceData?: Json; sync?: boolean }) => {
    const sourceData = (link.sourceData ?? {}) as Record<string, string>;

    return sourceData.type === slug && link.sync === true;
  });

  if (!syncing) {
    return { message: 'The linked issue is not syncing' };
  }

  const personal = issue.assigneeId
    ? await ctx.account.personal(slug, issue.team.workspaceId, issue.assigneeId)
    : null;

  const body = personal
    ? issueComment.bodyMarkdown
    : `>${author?.user?.fullname ?? 'Somebody'} commented from Vantik \n\n ${issueComment.bodyMarkdown}`;

  // An absolute URL GitHub gave us when the parent comment was mirrored in.
  // The egress check resolves it and refuses anything that is not GitHub, so a
  // `sourceMetadata` that has been tampered with cannot redirect this post.
  const response = await ctx.vendor.fetch(parentSource.commentApiUrl, {
    method: 'POST',
    as: personal ? 'user' : 'bot',
    headers: { ...GITHUB_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });

  if (!response.ok) {
    ctx.log.error(`GitHub refused the comment: ${response.status}`);

    return { message: `GitHub refused the comment (${response.status})` };
  }

  const created = await response.json();

  if (!created?.id) {
    return null;
  }

  return await ctx.links.createComment({
    url: created.url,
    sourceId: String(created.id),
    commentId: issueComment.id,
    sourceData: {
      id: created.id,
      body: created.body,
      displayUserName: created.user?.login,
      apiUrl: created.url,
    },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

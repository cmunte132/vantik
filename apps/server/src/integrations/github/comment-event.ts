import { type PluginContext } from 'plugins/plugin.interface';

/**
 * A comment written on GitHub, mirrored into the Vantik issue.
 *
 * The inbound half of `comment-sync`, ported from
 * `actions/github/triggers/comment-event.ts`. It reaches no vendor at all — the
 * webhook body already carries the comment — so it needs no credential and
 * makes no outbound call.
 */
export async function commentEvent(ctx: PluginContext, payload: Json) {
  const account = payload.integrationAccounts?.github;
  const body = payload.eventBody;

  if (!account || !body?.issue?.id) {
    return { message: 'Not a GitHub issue comment event' };
  }

  const links = await ctx.links.bySource(String(body.issue.id));

  if (!links?.length) {
    ctx.log.debug(`No linked issue for GitHub issue ${body.issue.id}`);

    return undefined;
  }

  const link = links[0];
  const sourceData = (link.sourceData ?? {}) as Record<string, string>;
  const slug = account.integrationDefinition?.slug;

  if (sourceData.type !== slug || link.sync !== true) {
    return { message: 'The linked issue is not syncing' };
  }

  if (body.action !== 'created') {
    return { message: `Unhandled comment action ${body.action}` };
  }

  // GitHub redelivers a webhook when it does not hear a timely 200, so the
  // same comment arrives more than once. Without this each redelivery is
  // another copy on the issue.
  const existing = await ctx.links.comment(String(body.comment.id));

  if (existing) {
    ctx.log.debug(`Comment ${body.comment.id} is already mirrored`);

    return existing.comment;
  }

  return await ctx.comments.create({
    issueId: link.issueId,
    parentId: sourceData.syncedCommentId,
    bodyMarkdown: body.comment.body,
    sourceMetadata: {
      id: account.id,
      type: slug,
      userDisplayName: body.sender?.login,
    },
    linkCommentMetadata: {
      url: body.comment.html_url,
      sourceId: String(body.comment.id),
      sourceData: {
        id: body.comment.id,
        body: body.comment.body,
        displayUserName: body.comment.user?.login,
        apiUrl: body.comment.url,
      },
      createdById: payload.userId,
    },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

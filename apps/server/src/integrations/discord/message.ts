import { type PluginContext } from 'plugins/plugin.interface';

/**
 * A Discord message arrived in a channel that mirrors an issue.
 *
 * Ported from `actions/discord/triggers/message.ts`, which ran under
 * trigger.dev and therefore never ran here at all. Two things changed, and
 * neither is cosmetic.
 *
 * The credential is gone. The original read `integrationDefinition.config
 * .botToken` and logged a `discord.js` client in with it; this asks the host to
 * make the call. `discord.js` goes with it — its two uses here, fetching a
 * channel and fetching a message, are one REST request each.
 *
 * And the writes go through capabilities rather than an SDK carrying the
 * caller's Vantik access token, so this code's authority is the handful of
 * operations below rather than the whole API.
 */
export async function discordMessage(
  ctx: PluginContext,
  eventBody: Record<string, unknown>,
) {
  const data = eventBody.d as Record<string, never>;
  const channelId = data?.channel_id as string;
  const messageId = data?.id as string;
  const author = data?.author as { username?: string } | undefined;

  // Our own bot's messages come back through the same webhook. Mirroring them
  // would append every reply we post to the issue that produced it.
  if (author?.username?.includes('Vantik')) {
    return { message: 'Ignoring a message from the Vantik bot' };
  }

  const links = await ctx.links.bySource(channelId);
  const link = Array.isArray(links) ? links[0] : links;

  if (!link) {
    ctx.log.debug(`No linked issue for Discord channel ${channelId}`);

    return { message: `No linked issue for channel ${channelId}` };
  }

  const response = await ctx.vendor.fetch(
    `/channels/${channelId}/messages/${messageId}`,
  );

  if (!response.ok) {
    ctx.log.error(
      `Discord refused the message ${messageId}: ${response.status}`,
    );

    return { message: `Could not read Discord message ${messageId}` };
  }

  const message = (await response.json()) as { content?: string };

  const existing = await ctx.links.comment(messageId);

  if (existing) {
    return await ctx.comments.update(existing.commentId, {
      body: '',
      bodyMarkdown: message.content,
    });
  }

  const sourceMetadata = {
    id: link.integrationAccountId,
    type: 'discord',
    channelId,
    userDisplayName: author?.username,
  };

  return await ctx.comments.create({
    issueId: link.issueId,
    body: '',
    bodyMarkdown: message.content,
    parentId: (link.sourceData as Record<string, string>)?.syncedCommentId,
    sourceMetadata,
  });
}

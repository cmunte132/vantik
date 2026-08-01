// The default `@tiptap/html` entry is the browser build and throws in Node.
// `common/utils/tiptap.utils.ts` documents the same trap; this is the second
// place to hit it, and a test caught it rather than a deployment.
import { generateJSON } from '@tiptap/html/server';
import { type PluginContext } from 'plugins/plugin.interface';

import { TIPTAP_EXTENSIONS } from './tiptap-extensions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

interface Header {
  name: string;
  value: string;
}

interface Attachment {
  filename: string;
  mimetype: string;
  attachmentId: string;
}

/**
 * An email arrived; turn it into an issue, or append to the one it belongs to.
 *
 * Ported from `actions/email/triggers/triage.ts`. The routing is the clever
 * part and is unchanged: the address a message was delivered to carries the
 * mapping key (`something+acme-support@…`), so which team an email lands in is
 * decided by what somebody typed in the To field.
 *
 * What changed is the attachments. The original streamed each one to
 * `/tmp/${attachment.filename}` and read it back — a writable filesystem it
 * never declared, a collision when two messages carry the same attachment name,
 * and a path built from a filename chosen by whoever sent the email. It hands
 * the host bytes now.
 */
export async function emailTriage(
  ctx: PluginContext,
  eventBody: Json,
  account: Json,
  action: Json,
) {
  const messageId = eventBody?.messageId;

  if (!messageId) {
    return { message: 'No message id on the event' };
  }

  const response = await ctx.vendor.fetch(
    `/gmail/v1/users/me/messages/${messageId}`,
  );

  if (!response.ok) {
    ctx.log.error(`Gmail refused message ${messageId}: ${response.status}`);

    return { message: `Gmail refused the message (${response.status})` };
  }

  const message = await response.json();
  const { payload, threadId } = message;

  if (!payload) {
    return undefined;
  }

  const header = (name: string) =>
    payload.headers?.find((h: Header) => h.name === name)?.value;

  const subject = header('Subject');
  const deliveredTo = header('Delivered-To');

  // `something+acme-support@…` — the part between the plus and the dash is
  // which mapping this message belongs to.
  const mappingKey = /\+([^-]+)-([^@]+)@/i.exec(deliveredTo ?? '')?.[2];

  const { teamId } =
    action?.data?.inputs?.teamMappings?.find(
      ({ id }: { id: string }) => id === mappingKey,
    ) ?? {};

  if (!teamId) {
    ctx.log.debug(`No team mapped for ${deliveredTo}`);

    return undefined;
  }

  const team = await ctx.workspace.team(teamId);

  if (!team) {
    ctx.log.debug(`No team ${teamId}`);

    return undefined;
  }

  const workflows = await ctx.workspace.workflows(teamId);
  const stateId = workflows.find(
    (workflow: Json) => workflow.category === 'TRIAGE',
  )?.id;

  const { html, attachments } = readParts(payload);

  const forwardedFrom =
    /From: <strong class="gmail_sendername" dir="auto">(.*?)<\/strong>/.exec(
      html,
    )?.[1] ||
    /^([^<]+)/.exec(header('From') ?? '')?.[1]?.trim() ||
    null;

  const tiptapJson = generateJSON(html, TIPTAP_EXTENSIONS) as Json;

  const sourceMetadata = {
    type: account?.integrationDefinition?.slug,
    messageId,
    threadId,
    userDisplayName: forwardedFrom,
  };

  const uploaded = await uploadAttachments(ctx, messageId, attachments);

  const links = await ctx.links.bySource(threadId);
  const link = Array.isArray(links) ? links[0] : links;

  // A reply to a thread we already track keeps the images and files already on
  // the issue; only the body is replaced.
  if (link) {
    const existing = JSON.parse(link.issue.description ?? '{"content":[]}');

    tiptapJson.content.push(
      ...existing.content.filter(
        (node: Json) => node.type === 'image' || node.type === 'fileExtension',
      ),
    );
  }

  tiptapJson.content.push(
    ...uploaded.map((attachment: Json) => ({
      type: attachment.fileType?.startsWith('image/')
        ? 'image'
        : 'fileExtension',
      attrs: {
        src: attachment.publicURL,
        alt: attachment.originalName,
        size: attachment.size,
      },
    })),
  );

  if (link) {
    return await ctx.issues.update(link.issueId, teamId, {
      description: JSON.stringify(tiptapJson),
      subscriberIds: link.issue.subscriberIds,
    });
  }

  return await ctx.issues.create(teamId, {
    title: subject,
    description: JSON.stringify(tiptapJson),
    stateId,
    sourceMetadata,
    linkIssueData: {
      url: `https://mail.google.com/mail/u/0/#inbox/${threadId}`,
      sourceId: threadId,
      sourceData: sourceMetadata,
    },
  });
}

/**
 * Walks the MIME tree for the HTML body and anything attached.
 *
 * A message is a tree rather than a list — `multipart/alternative` inside
 * `multipart/mixed` is ordinary — so this recurses rather than looping.
 */
function readParts(payload: Json): { html: string; attachments: Attachment[] } {
  let html = '';
  const attachments: Attachment[] = [];

  const walk = (parts: Json[]) => {
    for (const part of parts ?? []) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        html = Buffer.from(part.body.data, 'base64').toString('utf-8');
      } else if (part.mimeType?.startsWith('multipart/')) {
        walk(part.parts);
      } else if (part.filename && part.body?.attachmentId) {
        attachments.push({
          filename: part.filename,
          mimetype: part.mimeType,
          attachmentId: part.body.attachmentId,
        });
      }
    }
  };

  walk(payload.parts ?? [payload]);

  return { html, attachments };
}

/** Fetches each attachment and hands the host its bytes. */
async function uploadAttachments(
  ctx: PluginContext,
  messageId: string,
  attachments: Attachment[],
): Promise<Json[]> {
  const uploaded: Json[] = [];

  for (const attachment of attachments) {
    const response = await ctx.vendor.fetch(
      `/gmail/v1/users/me/messages/${messageId}/attachments/${attachment.attachmentId}`,
    );

    if (!response.ok) {
      ctx.log.error(
        `Gmail refused attachment ${attachment.filename}: ${response.status}`,
      );
      continue;
    }

    const body = await response.json();

    // Gmail returns base64url, which is not the same alphabet as base64.
    const bytes = Buffer.from(String(body.data ?? ''), 'base64url');

    uploaded.push(
      await ctx.attachments.upload({
        filename: attachment.filename,
        contentType: attachment.mimetype,
        bytes,
      }),
    );
  }

  return uploaded;
}

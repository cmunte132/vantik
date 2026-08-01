import {
  ActionTypesEnum,
  IntegrationEventPayload,
  IntegrationPayloadEventType,
  ModelNameEnum,
} from '@vantikhq/types';
import { type PluginContext } from 'plugins/plugin.interface';

import { integrationCreate } from './account-create';
import { commentEvent } from './comment-event';
import { commentSync } from './comment-sync';
import { getToken } from './get-token';
import { issueSync } from './issue-sync';
import { linkIssueSync } from './link-issue-sync';
import { prSync } from './pr-sync';
import { codeChangeOf } from './pull-request';
import { spec } from './spec';

export { githubSpec as pluginSpec } from './plugin-spec';

/**
 * GitHub: one vendor, one entry point, both halves.
 *
 * The connection half — spec, account creation, tokens — was already here. The
 * behaviour half arrives from `actions/github`, where it had been since
 * integrations were moved out to trigger.dev in 2024 and only the part a person
 * waits on during OAuth came back. The two were never different kinds of thing.
 * See ENG-89.
 */
export default async function run(
  eventPayload: IntegrationEventPayload,
  ctx: PluginContext,
) {
  // The connection half speaks `IntegrationPayloadEventType` and the behaviour
  // half `ActionTypesEnum`. One entry point, so the switch takes both.
  switch (eventPayload.event as string) {
    /* ── Connection ─────────────────────────────────────────────────────── */

    case IntegrationPayloadEventType.SPEC:
      return spec();

    // Used to save settings data
    case IntegrationPayloadEventType.CREATE:
      return await integrationCreate(
        ctx,
        eventPayload.userId,
        eventPayload.workspaceId,
        eventPayload.data,
      );

    case IntegrationPayloadEventType.GET_CONNECTED_ACCOUNT_ID:
      return eventPayload.data.eventBody.installation.id.toString();

    case IntegrationPayloadEventType.GET_TOKEN:
      return await getToken(ctx, eventPayload.integrationAccountId);

    // A pull request says which files it changes, and the server turns those
    // paths into modules. The bot token is the one that reads a private
    // repository of the installation.
    case IntegrationPayloadEventType.GET_CODE_CHANGE: {
      const { botToken } = await getToken(
        ctx,
        eventPayload.integrationAccountId,
      );

      return await codeChangeOf(eventPayload.eventBody, botToken);
    }

    case IntegrationPayloadEventType.IS_ACTION_SUPPORTED_EVENT:
      return true;

    /* ── Behaviour ──────────────────────────────────────────────────────── */

    case ActionTypesEnum.SOURCE_WEBHOOK as string:
      return await onWebhook(ctx, eventPayload);

    case ActionTypesEnum.ON_CREATE as string:
      switch (eventPayload.type) {
        case ModelNameEnum.IssueComment:
          return await commentSync(ctx, eventPayload);

        case ModelNameEnum.LinkedIssue:
          return await linkIssueSync(ctx, eventPayload);

        default:
          return { message: `Unhandled create of ${eventPayload.type}` };
      }

    case ActionTypesEnum.ON_UPDATE as string:
      switch (eventPayload.type) {
        case ModelNameEnum.Issue:
          return await onIssueUpdated(ctx, eventPayload);

        case ModelNameEnum.LinkedIssue:
          return await linkIssueSync(ctx, eventPayload);

        default:
          return { message: `Unhandled update of ${eventPayload.type}` };
      }

    default:
      return {
        message: `The event payload type is ${eventPayload.event}`,
      };
  }
}

/** Inbound from GitHub. */
async function onWebhook(
  ctx: PluginContext,
  eventPayload: IntegrationEventPayload,
) {
  const body = eventPayload.eventBody;
  const kind = eventPayload.eventHeaders?.['x-github-event'];

  // Our own bot's activity comes back through the same webhook. Without this,
  // a comment we mirrored to GitHub is mirrored straight back.
  if (
    ['vantik-bot[bot]', 'vantik-bot-dev[bot]'].includes(body?.sender?.login)
  ) {
    return { message: 'Ignoring our own bot' };
  }

  switch (kind) {
    case 'issue_comment':
      return await commentEvent(ctx, eventPayload);

    case 'pull_request':
      return await prSync(ctx, eventPayload);

    default:
      ctx.log.debug(`Unhandled GitHub event ${kind}`);

      return undefined;
  }
}

/**
 * A Vantik issue changed. Push it to every GitHub *issue* it is linked to.
 *
 * Pull requests are excluded on purpose: a pull request is not a mirror of the
 * issue, it is the work, and rewriting its title from the issue would be wrong.
 */
async function onIssueUpdated(
  ctx: PluginContext,
  eventPayload: IntegrationEventPayload,
) {
  const links = await ctx.links.forIssue(eventPayload.modelId);

  const mirrors = links.filter((link: { sourceData?: unknown }) => {
    const data = (link.sourceData ?? {}) as Record<string, string>;

    return data.type === 'github' && data.githubType !== 'PR';
  });

  if (!mirrors.length) {
    return { message: 'No linked GitHub issue to update' };
  }

  return await Promise.all(
    mirrors.map((linkedIssue: unknown) =>
      issueSync(ctx, { ...eventPayload, linkedIssue }),
    ),
  );
}

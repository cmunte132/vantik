import { ActionTypesEnum, RoleEnum } from '@vantikhq/types';
import { type PluginContext } from 'plugins/plugin.interface';

import { GITHUB_HEADERS } from './plugin-spec';
import {
  issueUrl,
  linkAndAnnounce,
  relativeTime,
  toApiUrl,
} from './sync-utils';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * Somebody linked a GitHub issue or pull request to a Vantik issue, or turned
 * that link's syncing on or off.
 *
 * Ported from `actions/github/triggers/link-issue-sync.ts`.
 */
export async function linkIssueSync(ctx: PluginContext, payload: Json) {
  switch (payload.event) {
    case ActionTypesEnum.ON_CREATE:
      return await onLinkCreated(ctx, payload);

    case ActionTypesEnum.ON_UPDATE:
      return await onLinkUpdated(ctx, payload);

    default:
      return { message: `Unhandled link event ${payload.event}` };
  }
}

async function onLinkCreated(ctx: PluginContext, payload: Json) {
  const account = payload.integrationAccounts?.github;

  if (!account || !payload.modelId) {
    return { message: 'No GitHub account for this workspace' };
  }

  const link = await ctx.links.get(payload.modelId);

  const users = await ctx.workspace.users();
  const actor = users.find((m: Json) => m.userId === link.updatedById);

  if (actor?.role === RoleEnum.BOT) {
    return { message: 'Ignoring a link made by a bot' };
  }

  const asPull =
    /^https:\/\/github\.com\/(?<repository>[^/]+\/[^/]+)\/pull\/\d+$/.exec(
      link.url,
    );
  const asIssue =
    /^https:\/\/github\.com\/(?<repository>[^/]+\/[^/]+)\/issues\/\d+$/.exec(
      link.url,
    );

  if (!asPull && !asIssue) {
    return { message: `Not a GitHub issue or pull request: ${link.url}` };
  }

  const isPull = Boolean(asPull);

  const response = await ctx.vendor.fetch(toApiUrl(link.url), {
    as: 'bot',
    headers: GITHUB_HEADERS,
  });

  if (!response.ok) {
    ctx.log.error(`GitHub refused ${link.url}: ${response.status}`);

    return { message: `GitHub refused the link (${response.status})` };
  }

  const remote = await response.json();
  const stateDate = remote.closed_at ?? remote.created_at;
  const slug = account.integrationDefinition?.slug;

  const sourceData = isPull
    ? {
        branch: remote.head?.ref,
        id: String(remote.id),
        closedAt: remote.closed_at,
        createdAt: remote.created_at,
        updatedAt: remote.updated_at,
        issueNumber: remote.number,
        state: remote.state,
        title: `#${remote.number} - ${remote.title}    -- ${remote.state} ${relativeTime(stateDate)}`,
        apiUrl: remote.url,
        commentApiUrl: remote.comments_url,
        mergedAt: remote.merged_at,
        displayName: remote.user?.login,
        githubType: 'PR',
        type: slug,
      }
    : {
        id: String(remote.id),
        issueNumber: remote.number,
        title: `#${remote.number} - ${remote.title}`,
        apiUrl: remote.url,
        htmlUrl: remote.html_url,
        type: slug,
        displayName: remote.user?.login,
        commentApiUrl: remote.comments_url,
        githubType: 'ISSUE',
      };

  // A pull request may be linked from several issues; a GitHub *issue* may not.
  // Two Vantik issues syncing to one GitHub issue would write over each other.
  if (!isPull) {
    const existing = await ctx.links.bySource(String(remote.id));

    if (existing?.length) {
      return { message: 'That GitHub issue is already linked' };
    }
  }

  return await linkAndAnnounce(ctx, {
    linkInput: {
      url: remote.html_url,
      sourceId: String(remote.id),
      issueId: link.issueId,
      sourceData,
      teamId: link.issue.teamId,
    },
    issue: link.issue,
    commentApiUrl: remote.comments_url,
    linkedIssueId: link.id,
    announce: false,
  });
}

async function onLinkUpdated(ctx: PluginContext, payload: Json) {
  const account = payload.integrationAccounts?.github;
  const changed = payload.changedData ?? {};

  if (!account || !payload.modelId) {
    return { message: 'No GitHub account for this workspace' };
  }

  if (changed.sync === undefined && !changed.deleted) {
    return { message: 'Nothing that affects GitHub changed' };
  }

  const link = await ctx.links.get(payload.modelId);

  const users = await ctx.workspace.users();
  const actor = users.find((m: Json) => m.userId === link.updatedById);

  if (actor?.role === RoleEnum.BOT) {
    return { message: 'Ignoring a change made by a bot' };
  }

  const sourceData = (link.sourceData ?? {}) as Record<string, string>;
  const identifier = `${link.issue.team.identifier}-${link.issue.number}`;
  const url = issueUrl(account.workspace?.slug ?? '', identifier);

  // Said out loud on the pull request, because somebody watching it needs to
  // know the mirror has stopped — silence reads as "still syncing".
  const body = changed.sync
    ? `This thread is syncing with a Vantik issue [${identifier}](${url})`
    : `Stopping sync with Vantik issue [${identifier}](${url})`;

  const response = await ctx.vendor.fetch(`${sourceData.apiUrl}/comments`, {
    method: 'POST',
    as: 'bot',
    headers: { ...GITHUB_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });

  if (!response.ok) {
    ctx.log.error(`GitHub refused the sync notice: ${response.status}`);
  }

  return { message: 'Told GitHub about the sync change' };
}

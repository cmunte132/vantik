import { type PluginContext } from 'plugins/plugin.interface';

import { GITHUB_HEADERS } from './plugin-spec';
import { issueUrl, relativeTime } from './sync-utils';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * Pull requests, linked to the issues they close.
 *
 * Ported from `actions/github/triggers/pr-sync.ts`, the largest file of the
 * vendor. Two ways a pull request finds its issue, in order: the branch name
 * (`someone/eng-42`), and failing that the commit messages, which carry an
 * identifier in brackets — `(ENG-42)`.
 */
export async function prSync(ctx: PluginContext, payload: Json) {
  const account = payload.integrationAccounts?.github;
  const body = payload.eventBody;
  const pull = body?.pull_request;

  if (!account || !pull) {
    return { message: 'Not a pull request event' };
  }

  const pullId = String(pull.id);
  const stateDate = pull.closed_at ?? pull.created_at;

  const sourceData = {
    branch: pull.head?.ref,
    id: pullId,
    closedAt: pull.closed_at,
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
    issueNumber: pull.number,
    state: pull.state,
    title: `#${pull.number} - ${pull.title}    -- ${pull.state} ${relativeTime(stateDate)}`,
    apiUrl: pull.url,
    htmlUrl: pull.html_url,
    commentApiUrl: pull.comments_url,
    mergedAt: pull.merged_at,
    githubType: 'PR',
    type: account.integrationDefinition?.slug,
  };

  switch (body.action) {
    case 'opened': {
      const branch = pull.head?.ref ?? '';
      const match = /^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)-(\d+)$/.exec(branch);

      // No conventional branch name is ordinary rather than an error — plenty
      // of people name branches however they like — so fall through to reading
      // the commits instead of giving up.
      if (!match) {
        ctx.log.debug(`Branch ${branch} is not issue-shaped; reading commits`);

        return await linkFromCommits(ctx, pull, sourceData);
      }

      const [, , teamSlug, issueNumber] = match;

      return await link(ctx, {
        pull,
        sourceData,
        teamSlug,
        issueNumber: Number(issueNumber),
      });
    }

    case 'closed':
      return await onClosed(ctx, { pullId, sourceData, account, body });

    case 'synchronize':
      return await linkFromCommits(ctx, pull, sourceData);

    default:
      ctx.log.debug(`Unhandled pull request action ${body.action}`);

      return undefined;
  }
}

/** Links one pull request to one issue, and says so on the pull request. */
async function link(
  ctx: PluginContext,
  parameters: {
    pull: Json;
    sourceData: Json;
    teamSlug: string;
    issueNumber: number;
  },
) {
  const team = await ctx.workspace.teamByName(parameters.teamSlug);

  if (!team) {
    ctx.log.debug(`No team named ${parameters.teamSlug}`);

    return undefined;
  }

  const issue = await ctx.issues.getByNumber(team.id, parameters.issueNumber);

  if (!issue) {
    ctx.log.debug(`No issue ${parameters.teamSlug}-${parameters.issueNumber}`);

    return undefined;
  }

  const linked = await ctx.links.create({
    url: parameters.pull.html_url,
    sourceId: String(parameters.pull.id),
    issueId: issue.id,
    title: parameters.sourceData.title,
    sourceData: parameters.sourceData,
    teamId: team.id,
  });

  const identifier = `${team.identifier}-${issue.number}`;

  await ctx.vendor.fetch(parameters.pull.comments_url, {
    method: 'POST',
    as: 'bot',
    headers: { ...GITHUB_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      body: `[${identifier} ${issue.title}](${issueUrl(
        team.workspace?.slug ?? '',
        identifier,
      )})`,
    }),
  });

  return linked;
}

/**
 * The fallback: read the commit messages for an issue identifier.
 *
 * Also the path taken on every push to an open pull request, so a commit that
 * names an issue links it even when the branch never did.
 */
async function linkFromCommits(
  ctx: PluginContext,
  pull: Json,
  sourceData: Json,
) {
  const response = await ctx.vendor.fetch(pull.commits_url, {
    as: 'bot',
    headers: GITHUB_HEADERS,
  });

  if (!response.ok) {
    ctx.log.error(`GitHub refused the commits: ${response.status}`);

    return { message: `GitHub refused the commits (${response.status})` };
  }

  const commits = await response.json();
  const pullId = String(pull.id);

  return await Promise.all(
    commits.map(async (commit: Json): Promise<Json> => {
      const match = /\(([a-zA-Z0-9_-]+)-(\d+)\)/.exec(
        commit.commit?.message ?? '',
      );

      if (!match) {
        return { message: 'No issue identifier in this commit' };
      }

      const [, teamSlug, issueNumber] = match;
      const team = await ctx.workspace.teamByName(teamSlug);

      if (!team) {
        return undefined;
      }

      // A commit can name an issue that does not exist — somebody typed the
      // wrong number — and that must not fail the whole webhook.
      const issue = await ctx.issues
        .getByNumber(team.id, Number(issueNumber))
        .catch((): Json => null);

      if (!issue) {
        return { message: `No issue ${teamSlug}-${issueNumber}` };
      }

      // Several commits in one push can name the same issue, and every push
      // re-reads the whole list, so without this the pull request is linked
      // again on each one.
      const existing = await ctx.links.bySource(pullId);

      if (existing?.some((l: Json) => l.issueId === issue.id)) {
        return { message: 'Already linked to that issue' };
      }

      return await link(ctx, {
        pull,
        sourceData,
        teamSlug,
        issueNumber: Number(issueNumber),
      });
    }),
  );
}

/**
 * A pull request closed. Close the issue too, but only when this was the last
 * one open against it and it was actually merged.
 */
async function onClosed(
  ctx: PluginContext,
  parameters: { pullId: string; sourceData: Json; account: Json; body: Json },
) {
  const { pullId, sourceData, account, body } = parameters;
  const links = await ctx.links.bySource(pullId);

  return await Promise.all(
    links.map(async (link: Json): Promise<Json> => {
      const forIssue = await ctx.links.forIssue(link.issueId);
      const openPulls = forIssue.filter((other: Json) => {
        const data = (other.sourceData ?? {}) as Record<string, string>;

        return data.githubType === 'PR' && data.state === 'open';
      });

      const match = openPulls.find((other: Json) => other.sourceId === pullId);

      if (!match) {
        ctx.log.debug(`No open link for pull request ${pullId}`);

        return undefined;
      }

      const updated = await ctx.links.update(match.id, { sourceData });

      // Only when this was the last one, and only when it merged: a pull
      // request that was closed without merging did not finish the work.
      if (openPulls.length <= 1 && sourceData.mergedAt) {
        const teamId = updated.issue?.team?.id ?? link.issue?.teamId;
        const workflows = await ctx.workspace.workflows(teamId);
        const done = workflows.find(
          (workflow: Json) => workflow.category === 'COMPLETED',
        );

        if (done) {
          await ctx.issues.update(link.issueId, teamId, {
            stateId: done.id,
            sourceMetadata: {
              id: account.id,
              type: account.integrationDefinition?.slug,
              userDisplayName: body.sender?.login,
            },
          });
        }
      }

      return updated;
    }),
  );
}

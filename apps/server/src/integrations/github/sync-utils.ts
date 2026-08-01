import { type PluginContext } from 'plugins/plugin.interface';

import { GITHUB_HEADERS } from './plugin-spec';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * The GitHub API URL for a browser URL somebody pasted.
 *
 * A person links `https://github.com/o/r/pull/4`; the API for it is
 * `https://api.github.com/repos/o/r/pulls/4`. Note `pull` becomes `pulls`.
 *
 * Anchored at both ends, and every part is a bounded character class, so a long
 * value cannot make it backtrack.
 */
export function toApiUrl(url: string): string {
  const matches =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)$/.exec(url);

  if (!matches) {
    return url;
  }

  const [, owner, repo, kind, number] = matches;

  return `https://api.github.com/repos/${owner}/${repo}/${
    kind === 'pull' ? 'pulls' : 'issues'
  }/${number}`;
}

/**
 * The address of an issue in this deployment's web app.
 *
 * The original hardcoded `https://app.vantik.dev`, so every comment a
 * self-hosted install posted to GitHub linked to somebody else's server. It
 * reads `FRONTEND_HOST` now, which is what the rest of the server uses.
 */
export function issueUrl(
  workspaceSlug: string,
  identifier: string,
  trailingHost = process.env.FRONTEND_HOST,
): string {
  const host = (trailingHost ?? '').replace(/\/+$/, '');

  return `${host}/${workspaceSlug}/issue/${identifier}`;
}

/**
 * "3 days ago", for the title of a linked pull request.
 *
 * A few lines rather than `date-fns`, which the server does not depend on. The
 * original ran inside a bundle that had its own dependency tree; adding one to
 * the server for a single relative-time string is a poor trade.
 */
export function relativeTime(when: string | Date): string {
  const then = new Date(when).getTime();

  if (Number.isNaN(then)) {
    return '';
  }

  const seconds = Math.round((Date.now() - then) / 1000);
  const units: Array<[number, string]> = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [30, 'day'],
    [12, 'month'],
    [Number.POSITIVE_INFINITY, 'year'],
  ];

  let amount = Math.abs(seconds);
  let unit = 'second';

  for (const [size, name] of units) {
    if (amount < size) {
      unit = name;
      break;
    }

    unit = name;
    amount = Math.floor(amount / size);
  }

  const plural = amount === 1 ? '' : 's';

  return seconds < 0
    ? `in ${amount} ${unit}${plural}`
    : `${amount} ${unit}${plural} ago`;
}

/**
 * Announces on GitHub that a thread is mirrored, and records the link.
 *
 * Posting the comment is what makes the link visible to somebody reading the
 * pull request, who would otherwise have no idea an issue was tracking it.
 */
export async function linkAndAnnounce(
  ctx: PluginContext,
  parameters: {
    linkInput: Json;
    issue: Json;
    commentApiUrl: string;
    sourceData?: Json;
    linkedIssueId?: string;
    announce?: boolean;
  },
) {
  const { linkInput, issue, commentApiUrl, linkedIssueId } = parameters;

  const team = await ctx.workspace.team(issue.teamId);
  const identifier = `${team.identifier}-${issue.number}`;

  if (parameters.announce !== false) {
    const body = `[${identifier} ${issue.title}](${issueUrl(
      team.workspace?.slug ?? '',
      identifier,
    )})`;

    const response = await ctx.vendor.fetch(commentApiUrl, {
      method: 'POST',
      as: 'bot',
      headers: { ...GITHUB_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });

    if (!response.ok) {
      ctx.log.error(`GitHub refused the link comment: ${response.status}`);
    }
  }

  // An update when the link already exists, a create when it does not. The
  // caller knows which, because it either found the row or is making it.
  return linkedIssueId
    ? await ctx.links.update(linkedIssueId, linkInput)
    : await ctx.links.create(linkInput);
}

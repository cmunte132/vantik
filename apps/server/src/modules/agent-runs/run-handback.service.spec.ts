/**
 * What a run leaves on the issue.
 *
 * This is the only thing a reader of an issue ever sees of a run, so both
 * halves are asserted here rather than at the executor: the link to what was
 * produced, and the comment describing it. Both used to live on the reporting
 * path that only one backend took, and a run on the other backend left the
 * issue untouched.
 */
import { PrismaService } from 'nestjs-prisma';

import type IssueCommentsService from 'modules/issue-comments/issue-comments.service';
import type LinkedIssueService from 'modules/linked-issue/linked-issue.service';

import { RunHandbackService } from './run-handback.service';

const ISSUE = 'issue-1';
const AGENT = 'agent-1';
const RUN = 'run-1';

function build(
  options: {
    criteria?: Array<{ body: string; completed: boolean }>;
    linkThrows?: boolean;
  } = {},
) {
  const prisma = {
    checklistItem: {
      findMany: jest.fn(async () => options.criteria ?? []),
    },
  } as unknown as PrismaService;

  const posted: Array<{ issueId: string; userId: string; body: string }> = [];
  const comments = {
    createIssueComment: jest.fn(
      async (
        params: { issueId: string },
        userId: string,
        data: { bodyMarkdown: string },
      ) => {
        posted.push({
          issueId: params.issueId,
          userId,
          body: data.bodyMarkdown,
        });
        return { id: 'comment-1' };
      },
    ),
  } as unknown as IssueCommentsService;

  const linked: Array<{ url: string; issueId: string }> = [];
  const linkedIssues = {
    getLinkedIssueByUrl: jest.fn(async (url: string) =>
      linked.filter((entry) => entry.url === url),
    ),
    createLinkIssue: jest.fn(
      async (data: { url: string }, params: { issueId: string }) => {
        if (options.linkThrows) {
          throw new Error('the link table is unreachable');
        }
        linked.push({ url: data.url, issueId: params.issueId });
        return { id: 'linked-1' };
      },
    ),
  } as unknown as LinkedIssueService;

  const service = new RunHandbackService(prisma, comments, linkedIssues);

  return { service, posted, linked, linkedIssues, comments };
}

describe('the pull request lands on the issue', () => {
  it('links it, whichever backend produced it', async () => {
    const { service, linked, posted } = build();

    await service.post(ISSUE, AGENT, RUN, {
      status: 'SUCCEEDED',
      summary: 'Added the deleted check and a regression test.',
      branch: 'agent/eng-42',
      prUrl: 'https://example.test/pr/7',
      attempt: 1,
    });

    expect(linked).toEqual([
      { url: 'https://example.test/pr/7', issueId: ISSUE },
    ]);
    // Authored by the agent user, not by whoever delegated.
    expect(posted[0]).toMatchObject({ issueId: ISSUE, userId: AGENT });
    expect(posted[0].body).toContain('https://example.test/pr/7');
  });

  it('does not link the same pull request twice', async () => {
    const { service, linkedIssues } = build();

    const outcome = {
      status: 'SUCCEEDED' as const,
      branch: 'agent/eng-42',
      prUrl: 'https://example.test/pr/7',
      attempt: 1,
    };

    await service.post(ISSUE, AGENT, RUN, outcome);
    await service.post(ISSUE, AGENT, RUN, outcome);

    expect(linkedIssues.createLinkIssue).toHaveBeenCalledTimes(1);
  });

  it('still comments when the link cannot be created', async () => {
    // A missing link row is a smaller loss than a run that said nothing. The
    // url is in the comment either way, so the work stays reachable.
    const { service, posted } = build({ linkThrows: true });

    await service.post(ISSUE, AGENT, RUN, {
      status: 'SUCCEEDED',
      summary: 'Done.',
      prUrl: 'https://example.test/pr/7',
      attempt: 1,
    });

    expect(posted[0].body).toContain('https://example.test/pr/7');
  });

  it('links nothing when there is no remote to push to', async () => {
    const { service, posted, linkedIssues } = build();

    await service.post(ISSUE, AGENT, RUN, {
      status: 'SUCCEEDED',
      summary: 'Done.',
      branch: 'agent/eng-42',
      worktreePath: '/Users/dev/worktrees/eng-42',
      attempt: 1,
    });

    expect(posted[0].body).toContain('cd /Users/dev/worktrees/eng-42');
    expect(posted[0].body).toContain('agent/eng-42');
    expect(linkedIssues.createLinkIssue).not.toHaveBeenCalled();
  });
});

describe('the comment reads usefully whatever happened', () => {
  it('says what broke, in prose, with what it managed first', async () => {
    const { service, posted } = build();

    await service.post(ISSUE, AGENT, RUN, {
      status: 'FAILED',
      failure: 'ENVIRONMENT_SETUP_FAILED',
      error: 'pnpm install exited 1',
      summary: 'Read the failing spec before the install broke.',
      attempt: 2,
    });

    // A failed run deserves as much design as a successful one.
    expect(posted[0].body).toContain('the environment would not build');
    expect(posted[0].body).toContain('attempt 2');
    expect(posted[0].body).toContain('Read the failing spec');
    expect(posted[0].body).toContain('pnpm install exited 1');
  });

  it('asks for a human when nothing signed the work off', async () => {
    const { service, posted } = build();

    await service.post(ISSUE, AGENT, RUN, {
      status: 'NEEDS_REVIEW',
      summary: 'This issue cannot be pinned down with tests.',
      branch: 'agent/eng-42',
      attempt: 1,
    });

    expect(posted[0].body).toContain('Needs a human');
    expect(posted[0].body).toContain('cannot be pinned down');
  });

  it('states which criteria are still open, and ticks none of them', async () => {
    const { service, posted } = build({
      criteria: [
        { body: 'The deleted check is applied', completed: true },
        { body: 'A regression test covers it', completed: false },
      ],
    });

    await service.post(ISSUE, AGENT, RUN, {
      status: 'SUCCEEDED',
      summary: 'Done.',
      attempt: 1,
    });

    expect(posted[0].body).toContain('1 of 2 ticked');
    expect(posted[0].body).toContain('- [ ] A regression test covers it');
  });

  it('says nothing about a Definition of Done the issue never set', async () => {
    const { service, posted } = build({ criteria: [] });

    await service.post(ISSUE, AGENT, RUN, {
      status: 'SUCCEEDED',
      summary: 'Done.',
      attempt: 1,
    });

    expect(posted[0].body).not.toContain('Definition of Done');
  });
});

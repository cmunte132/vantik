import { prSync } from './pr-sync';

/**
 * What a pull request's end tells the runs that opened it.
 *
 * The linking and the issue closing are older and are exercised elsewhere;
 * what is pinned here is the report to the host — merged, closed without
 * merging, reopened — and that the issue's own handling never waits on it.
 */

const PR_URL = 'https://github.com/acme/api/pull/12';

/**
 * Where it was opened from, and when: how a pull request a person opened from
 * a run's branch finds the run.
 */
const FROM = {
  branch: 'agent/eng-42',
  repo: 'acme/api',
  openedAt: '2026-09-01T09:00:00Z',
};

function contextFor() {
  const ctx = {
    log: { debug: jest.fn(), error: jest.fn(), info: jest.fn() },
    agentRuns: {
      pullRequestChanged: jest.fn(async (): Promise<unknown> => ({ runs: 1 })),
    },
    links: {
      bySource: jest.fn(async (): Promise<unknown[]> => []),
      forIssue: jest.fn(async (): Promise<unknown[]> => []),
      update: jest.fn(),
    },
    workspace: {
      workflows: jest.fn(async (): Promise<unknown[]> => []),
      teamByName: jest.fn(async (): Promise<unknown> => null),
    },
    issues: { update: jest.fn() },
    vendor: {
      fetch: jest.fn(async () => ({ ok: false, status: 404 })),
    },
  };

  return ctx;
}

function payloadFor(
  action: string,
  pull: { state: string; merged_at?: string | null; closed_at?: string | null },
) {
  return {
    integrationAccount: {
      id: 'account-1',
      integrationDefinition: { slug: 'github' },
    },
    eventBody: {
      action,
      pull_request: {
        id: 5,
        number: 12,
        title: 'Fix the thing',
        html_url: PR_URL,
        created_at: '2026-09-01T09:00:00Z',
        head: { ref: 'agent/eng-42', repo: { full_name: 'acme/api' } },
        merged_at: null as string | null,
        closed_at: null as string | null,
        ...pull,
      },
    },
  };
}

describe('a pull request reported to the runs that opened it', () => {
  it('[KG-3.5] reports a merge, with when it closed', async () => {
    const ctx = contextFor();

    await prSync(
      ctx as never,
      payloadFor('closed', {
        state: 'closed',
        merged_at: '2026-09-02T10:00:00Z',
        closed_at: '2026-09-02T10:00:00Z',
      }),
    );

    expect(ctx.agentRuns.pullRequestChanged).toHaveBeenCalledWith({
      url: PR_URL,
      state: 'MERGED',
      closedAt: '2026-09-02T10:00:00Z',
      ...FROM,
    });
    // The issue side still ran.
    expect(ctx.links.bySource).toHaveBeenCalledWith('5');
  });

  it('[KG-3.5] reports a close without a merge as closed', async () => {
    const ctx = contextFor();

    await prSync(
      ctx as never,
      payloadFor('closed', {
        state: 'closed',
        closed_at: '2026-09-02T10:00:00Z',
      }),
    );

    expect(ctx.agentRuns.pullRequestChanged).toHaveBeenCalledWith({
      url: PR_URL,
      state: 'CLOSED',
      closedAt: '2026-09-02T10:00:00Z',
      ...FROM,
    });
  });

  it('[KG-3.5] reports a reopen as open again, so a close can be taken back', async () => {
    const ctx = contextFor();

    await prSync(ctx as never, payloadFor('reopened', { state: 'open' }));

    expect(ctx.agentRuns.pullRequestChanged).toHaveBeenCalledWith({
      url: PR_URL,
      state: 'OPEN',
      closedAt: null,
      ...FROM,
    });
    expect(ctx.links.bySource).not.toHaveBeenCalled();
  });

  it('[KG-3.5] goes on closing the issue when the report fails', async () => {
    const ctx = contextFor();
    ctx.agentRuns.pullRequestChanged.mockRejectedValueOnce(
      new Error('database is down'),
    );

    await expect(
      prSync(
        ctx as never,
        payloadFor('closed', {
          state: 'closed',
          merged_at: '2026-09-02T10:00:00Z',
          closed_at: '2026-09-02T10:00:00Z',
        }),
      ),
    ).resolves.toEqual([]);

    expect(ctx.log.error).toHaveBeenCalledWith(expect.stringContaining(PR_URL));
    expect(ctx.links.bySource).toHaveBeenCalledWith('5');
  });

  it('[KG-3.5] says nothing when a pull request is only opened or pushed to', async () => {
    const ctx = contextFor();

    for (const action of ['opened', 'synchronize', 'edited']) {
      await prSync(ctx as never, payloadFor(action, { state: 'open' }));
    }

    expect(ctx.agentRuns.pullRequestChanged).not.toHaveBeenCalled();
  });
});

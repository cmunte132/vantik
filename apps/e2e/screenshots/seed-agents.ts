import { randomUUID } from 'node:crypto';

import { type APIRequestContext } from '@playwright/test';

import { ok, type Issue } from '../src/api';
import type { Account } from '../src/auth';
import type { Database } from './db';

/**
 * What the agent pages show: a model the workspace can use, a repository the
 * storefront's code lives in, and five runs on four issues, one in each state
 * a reader needs to recognise.
 *
 * Every run is one the hosted executor can produce: its failure category, its
 * events and its counts are the ones that executor writes. Its own notes and
 * check results are written as it writes them (one event per check, with no
 * counts or output); the agent's tool calls as pi-events.ts maps them. The
 * model id is set only on a run that finished, and a live run carries the
 * cost and turns its meter has written so far. A finished run
 * carries its turn count in iterationCount too, because the executor writes it
 * there when the run ends, and the Spend card shows that field as passes.
 *
 * The agent account and the module's repository go through the API. The rest
 * has no endpoint, because only a person delegating and a real executor make
 * it, so it is written as rows (see db.ts). Times are set from the capture's
 * frozen clock, so an elapsed time or a "2 days ago" reads the same on every
 * run.
 */

export interface SeededAgents {
  runningRunId: string;
  succeededRunId: string;
  rejectedRunId: string;
  failedRunId: string;
  handedOverRunId: string;
  /** A local omp run that finished and was continued in the person's terminal. */
  localRunId: string;
  /** A local omp run still working, with a question open for the person. */
  askingRunId: string;
  askingQuestionId: string;
  /** The key of the issue the finished local run worked on, such as ENG-12. */
  localIssueKey: string;
}

interface Input {
  owner: Account;
  /** The frozen clock the capture runs at, in ms. */
  clockAt: number;
  modules: { web: string; payments: string; catalog: string };
  /** The delegating person's personal agent, which a local run works as. */
  personalAgentId: string;
  issues: {
    running: Issue;
    succeeded: Issue;
    rejected: Issue;
    failed: Issue;
    /** Worked by a local run that finished and was continued in a terminal. */
    local: Issue;
    /** Worked by a local run that is waiting on an answer. */
    asking: Issue;
  };
}

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** The models the workspace's key reaches, as a provider catalogue lists them. */
const MODELS = [
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { id: 'claude-opus-4-1', label: 'Claude Opus 4.1' },
];

const CONFIG = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  thinking: 'medium',
  limits: { maxCostUsd: 5 },
};

/** What a local run is asked to use: a model of the person's own omp. */
const LOCAL_CONFIG = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  thinking: 'high',
};

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/** One line of a run's activity: seconds after it started, then what. */
type Line = [
  seconds: number,
  phase: string,
  message: string,
  data?: Record<string, unknown>,
  level?: Level,
];

export async function seedAgents(
  api: APIRequestContext,
  db: Database,
  { owner, clockAt, modules, personalAgentId, issues }: Input,
): Promise<SeededAgents> {
  const workspaceId = owner.workspaceId;

  const agent = await ok<{ id: string }>(
    await api.post('/v1/users/agents', {
      data: { name: 'Acme build agent', ownership: 'workspace' },
    }),
    'creating the workspace agent',
  );

  await modelKey(api, db, workspaceId);
  await repository(api, db, owner, modules.web);

  const run = async (
    issue: Issue,
    fields: Record<string, unknown> & { startedAt: number },
    lines: Line[],
  ) => {
    const { startedAt, ...rest } = fields;
    const id = await db.insert('AgentRun', {
      workspaceId,
      issueId: issue.id,
      agentUserId: agent.id,
      createdById: owner.userId,
      executor: 'hosted',
      attempt: 1,
      config: CONFIG,
      modelId: CONFIG.model,
      harnessVersion: 'pi 0.42.1',
      createdAt: new Date(startedAt - 20_000),
      claimedAt: new Date(startedAt - 5_000),
      startedAt: new Date(startedAt),
      ...rest,
    });
    for (const [seconds, phase, message, data, level] of lines) {
      await db.insert('AgentRunEvent', {
        runId: id,
        at: new Date(startedAt + seconds * 1000),
        level: level ?? 'INFO',
        phase,
        message,
        data: data ?? null,
      }, { updatedAt: false });
    }
    return id;
  };

  // In flight: the tests are running now. No lease, so the sweeper, which
  // expires only runs whose lease has lapsed, leaves it alone.
  const runningStart = clockAt - 6 * MINUTE - 40_000;
  const runningRunId = await run(
    issues.running,
    {
      status: 'RUNNING',
      startedAt: runningStart,
      iterationCount: 0,
      modelId: null,
      result: { costUsd: 0.94, turns: 17 },
    },
    [
      ...setup(),
      [62, 'implement', 'Running the agent'],
      [70, 'implement', 'Read src/payments/webhooks.ts', { kind: 'read', target: 'src/payments/webhooks.ts' }],
      [74, 'implement', 'Read src/payments/provider.ts', { kind: 'read', target: 'src/payments/provider.ts' }],
      [79, 'implement', 'Read src/orders/apply-payment.ts', { kind: 'read', target: 'src/orders/apply-payment.ts' }],
      [88, 'implement', 'Searched for eventId', { kind: 'search', target: 'eventId' }],
      [
        120,
        'implement',
        'Note',
        {
          kind: 'note',
          text: 'The provider retries a webhook until it gets a 2xx. The handler applies the payment before it replies, so a slow commit makes the provider send the event again and the order is paid twice. Recording each event id before applying it makes a repeat a no-op.',
        },
      ],
      [160, 'implement', 'Created migrations/0042_webhook_events.sql', { kind: 'write', ref: 'w1', target: 'migrations/0042_webhook_events.sql' }],
      [161, 'implement', 'Created migrations/0042_webhook_events.sql', { ref: 'w1', ok: true, added: 9, removed: 0 }],
      [210, 'implement', 'Edit src/payments/webhooks.ts', { kind: 'write', ref: 'w2', target: 'src/payments/webhooks.ts' }],
      [
        211,
        'implement',
        'Edit src/payments/webhooks.ts',
        {
          ref: 'w2',
          ok: true,
          added: 21,
          removed: 6,
          diff: [
            '@@ -18,9 +18,24 @@ export async function handleWebhook(event: ProviderEvent) {',
            '-  await applyPayment(event.data.orderId, event.data.amount);',
            '-  return { status: 200 };',
            '+  const first = await db.webhookEvents.insertIfAbsent(event.id);',
            '+  if (!first) {',
            '+    // Already applied: the provider is retrying an event we answered late.',
            '+    return { status: 200 };',
            '+  }',
            '+  await applyPayment(event.data.orderId, event.data.amount);',
            '+  return { status: 200 };',
          ].join('\n'),
        },
      ],
      [250, 'implement', 'Edit src/payments/webhooks.spec.ts', { kind: 'write', ref: 'w3', target: 'src/payments/webhooks.spec.ts' }],
      [251, 'implement', 'Edit src/payments/webhooks.spec.ts', { ref: 'w3', ok: true, added: 34, removed: 0 }],
      [298, 'verify', 'Running the repository’s own checks'],
    ],
  );

  // Done, with a pull request and the reviewer's approval.
  const succeededStart = clockAt - 2 * DAY - 3 * 60 * MINUTE;
  const succeededRunId = await run(
    issues.succeeded,
    {
      status: 'SUCCEEDED',
      startedAt: succeededStart,
      finishedAt: new Date(succeededStart + 14 * MINUTE + 12_000),
      iterationCount: 23,
      summary:
        'The address form re-rendered on every keystroke because the autofill handler replaced the whole form state, which dropped focus. It now merges the autofilled fields into the existing state. Added a test that autofills the form and checks the focused field keeps focus.',
      result: {
        delivery: 'pull_request',
        branch: 'agent/eng-5',
        prUrl: 'https://github.com/acme/storefront/pull/42',
        headCommit: '9b1c4e7',
        filesChanged: 2,
        insertions: 38,
        deletions: 7,
        promptTokens: 412_880,
        completionTokens: 18_204,
        costUsd: 1.37,
        turns: 23,
        reviewPasses: 1,
      },
      phaseTimings: {
        setup: 64_000,
        implement: 498_000,
        verify: 121_000,
        review: 142_000,
        report: 27_000,
      },
    },
    [
      ...setup(),
      [62, 'implement', 'Running the agent'],
      [72, 'implement', 'Read src/checkout/address-form.tsx', { kind: 'read', target: 'src/checkout/address-form.tsx' }],
      [75, 'implement', 'Read src/checkout/use-autofill.ts', { kind: 'read', target: 'src/checkout/use-autofill.ts' }],
      [
        140,
        'implement',
        'Note',
        {
          kind: 'note',
          text: 'useAutofill calls setForm(autofilled), which replaces the state object and remounts every input. Merging the fields keeps the inputs mounted.',
        },
      ],
      [300, 'implement', 'Edit src/checkout/use-autofill.ts', { kind: 'write', ref: 'w1', target: 'src/checkout/use-autofill.ts' }],
      [301, 'implement', 'Edit src/checkout/use-autofill.ts', { ref: 'w1', ok: true, added: 9, removed: 7 }],
      [420, 'implement', 'Edit src/checkout/address-form.spec.tsx', { kind: 'write', ref: 'w2', target: 'src/checkout/address-form.spec.tsx' }],
      [421, 'implement', 'Edit src/checkout/address-form.spec.tsx', { ref: 'w2', ok: true, added: 29, removed: 0 }],
      [450, 'implement', 'bash: pnpm test src/checkout', { kind: 'test', ref: 'a1', command: 'pnpm test src/checkout' }],
      [528, 'implement', 'Tests passed: 48', { kind: 'test', ref: 'a1', ok: true, passed: 48, failed: 0 }],
      [560, 'verify', 'Running the repository’s own checks'],
      [640, 'verify', 'Tests: passed', { kind: 'test', command: 'pnpm test', ok: true, exit: 0 }],
      [702, 'verify', 'Typecheck: passed', { kind: 'test', command: 'pnpm typecheck', ok: true, exit: 0 }],
      [705, 'review', 'Reviewing the work against the issue'],
      [825, 'review', 'The reviewer accepted the work'],
      [830, 'report', 'Pushing the branch'],
    ],
  );
  await db.insert('LinkedIssue', {
    url: 'https://github.com/acme/storefront/pull/42',
    sourceData: { source: 'agent-run', agentRunId: succeededRunId },
    createdById: owner.userId,
    issueId: issues.succeeded.id,
  });

  // Finished but not kept: the reviewer objected without citing anything, so
  // the cycle handed it to a person, who rejected it and had the branch
  // cleaned up. No failure category: a rejected run never carries one, and
  // with one the outcome card reads "Could not finish" instead of "Rejected".
  const rejectedStart = clockAt - DAY - 5 * 60 * MINUTE;
  const rejectedFinish = rejectedStart + 9 * MINUTE;
  const rejectedRunId = await run(
    issues.rejected,
    {
      status: 'NEEDS_REVIEW',
      startedAt: rejectedStart,
      finishedAt: new Date(rejectedFinish),
      iterationCount: 14,
      summary:
        'Listed the eleven checkout events with their properties in docs/analytics/checkout.md.',
      result: {
        delivery: 'pull_request',
        branch: 'agent/eng-8',
        prUrl: 'https://github.com/acme/storefront/pull/43',
        headCommit: '4e0a2d1',
        filesChanged: 1,
        insertions: 96,
        deletions: 0,
        costUsd: 0.61,
        turns: 14,
        reviewPasses: 1,
        cleanedUp: {
          at: new Date(rejectedFinish + 3 * 60 * MINUTE).toISOString(),
          byUserId: owner.userId,
          pullRequest: 'closed',
          branch: 'deleted',
        },
      },
      phaseTimings: { setup: 61_000, implement: 340_000, verify: 62_000, review: 90_000, report: 24_000 },
    },
    [
      ...setup(),
      [62, 'implement', 'Running the agent'],
      [70, 'implement', 'Read src/analytics/events.ts', { kind: 'read', target: 'src/analytics/events.ts' }],
      [74, 'implement', 'Read src/checkout/track.ts', { kind: 'read', target: 'src/checkout/track.ts' }],
      [300, 'implement', 'Created docs/analytics/checkout.md', { kind: 'write', ref: 'w1', target: 'docs/analytics/checkout.md' }],
      [301, 'implement', 'Created docs/analytics/checkout.md', { ref: 'w1', ok: true, added: 96, removed: 0 }],
      [400, 'verify', 'Running the repository’s own checks'],
      [460, 'verify', 'Lint: passed', { kind: 'test', command: 'pnpm lint', ok: true, exit: 0 }],
      [462, 'review', 'Reviewing the work against the issue'],
      [550, 'review', 'The reviewer found 0 thing(s) to fix'],
      [552, 'report', 'Pushing the branch'],
      [
        540 + 3 * 60 * 60,
        'cleanup',
        'Cleaned up after the run. Closed the pull request. Deleted the branch.',
        { cleanup: { pullRequest: 'closed', branch: 'deleted' } },
      ],
    ],
  );

  // Failed: the setup command of the repository broke, so the agent never
  // started. Nothing was pushed, so there is nothing to clean up.
  const failedStart = clockAt - 6 * 60 * MINUTE;
  const failedRunId = await run(
    issues.failed,
    {
      status: 'FAILED',
      failure: 'ENVIRONMENT_SETUP_FAILED',
      modelId: null,
      error:
        'pnpm install --frozen-lockfile\n ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with package.json',
      startedAt: failedStart,
      finishedAt: new Date(failedStart + 58_000),
      result: { egressDenied: 0 },
    },
    [
      [2, 'setup', 'Fetching the repository'],
      [9, 'setup', 'Starting the sandbox'],
      [40, 'setup', 'Preparing the sandbox'],
    ],
  );

  // Handed over: after the lockfile was fixed, the issue was delegated again.
  // The checks still failed after three passes, which is the limit, so the
  // cycle gave the work to a person with the pull request open.
  const handedOverStart = clockAt - 4 * 60 * MINUTE;
  const handedOverRunId = await run(
    issues.failed,
    {
      status: 'NEEDS_REVIEW',
      startedAt: handedOverStart,
      finishedAt: new Date(handedOverStart + 24 * MINUTE + 10_000),
      iterationCount: 41,
      summary:
        'Added a stock badge to the product page. Two tests in src/catalog/stock.spec.ts still fail: the badge shows when stock is unknown, and stock above 99 is not rounded.',
      result: {
        delivery: 'pull_request',
        branch: 'agent/eng-9',
        prUrl: 'https://github.com/acme/storefront/pull/44',
        headCommit: '7f3e9a0',
        filesChanged: 3,
        insertions: 64,
        deletions: 12,
        costUsd: 2.84,
        turns: 41,
        reviewPasses: 3,
      },
      phaseTimings: {
        setup: 66_000,
        implement: 330_000,
        verify: 98_000,
        review: 92_000,
        'revise-2': 240_000,
        'verify-2': 95_000,
        'review-2': 88_000,
        'revise-3': 220_000,
        'verify-3': 97_000,
        'review-3': 90_000,
        report: 26_000,
      },
    },
    [
      ...setup(),
      [62, 'implement', 'Running the agent'],
      [71, 'implement', 'Read src/catalog/product-page.tsx', { kind: 'read', target: 'src/catalog/product-page.tsx' }],
      [75, 'implement', 'Read src/catalog/stock.ts', { kind: 'read', target: 'src/catalog/stock.ts' }],
      [300, 'implement', 'Created src/catalog/stock-badge.tsx', { kind: 'write', ref: 'w1', target: 'src/catalog/stock-badge.tsx' }],
      [301, 'implement', 'Created src/catalog/stock-badge.tsx', { ref: 'w1', ok: true, added: 41, removed: 0 }],
      [396, 'verify', 'Running the repository’s own checks'],
      [494, 'verify', 'Tests: failed', { kind: 'test', command: 'pnpm test', ok: false, exit: 1 }, 'ERROR'],
      [496, 'review', 'Reviewing the work against the issue'],
      [588, 'review', 'The reviewer found 2 thing(s) to fix'],
      [590, 'revise-2', 'Fixing 2 finding(s) from the review'],
      [700, 'revise-2', 'Edit src/catalog/stock-badge.tsx', { kind: 'write', ref: 'w2', target: 'src/catalog/stock-badge.tsx' }],
      [701, 'revise-2', 'Edit src/catalog/stock-badge.tsx', { ref: 'w2', ok: true, added: 6, removed: 2 }],
      [830, 'verify-2', 'Running the repository’s own checks'],
      [923, 'verify-2', 'Tests: failed', { kind: 'test', command: 'pnpm test', ok: false, exit: 1 }, 'ERROR'],
      [925, 'review-2', 'Reviewing the work against the issue'],
      [1013, 'review-2', 'The reviewer found 2 thing(s) to fix'],
      [1015, 'revise-3', 'Fixing 2 finding(s) from the review'],
      [1120, 'revise-3', 'Edit src/catalog/stock.ts', { kind: 'write', ref: 'w3', target: 'src/catalog/stock.ts' }],
      [1121, 'revise-3', 'Edit src/catalog/stock.ts', { ref: 'w3', ok: true, added: 17, removed: 10 }],
      [1235, 'verify-3', 'Running the repository’s own checks'],
      [1330, 'verify-3', 'Tests: failed', { kind: 'test', command: 'pnpm test', ok: false, exit: 1 }, 'ERROR'],
      [1332, 'review-3', 'Reviewing the work against the issue'],
      [1420, 'review-3', 'The reviewer found 2 thing(s) to fix'],
      [1424, 'report', 'Pushing the branch'],
    ],
  );

  const local = await seedLocalRuns(db, {
    owner,
    clockAt,
    agentUserId: personalAgentId,
    finishedIssue: issues.local,
    askingIssue: issues.asking,
  });

  return {
    runningRunId,
    succeededRunId,
    rejectedRunId,
    failedRunId,
    handedOverRunId,
    ...local,
  };
}

/**
 * Two runs on the person's own machine, as the local executor records them
 * (executors/local.executor.ts): the run is the `local` executor's, it works as
 * the person's personal agent, and omp's own session id is in its result and
 * on its session row. Its worktree is on the person's machine, so the path is
 * made up.
 *
 * The first finished and left a branch. The person then resumed its omp
 * session in a terminal and sent one more prompt, which the connector read
 * from the session file (connector/session-activity.service.ts): those steps
 * have the phase `terminal`, and the terminal turn and its cost are added to
 * the run and counted on the session. A terminal holds the session now.
 *
 * The second is still working and has asked a person a question with the
 * `ask_person` tool, so the question is open (source `tool`).
 */
async function seedLocalRuns(
  db: Database,
  {
    owner,
    clockAt,
    agentUserId,
    finishedIssue,
    askingIssue,
  }: {
    owner: Account;
    clockAt: number;
    agentUserId: string;
    finishedIssue: Issue;
    askingIssue: Issue;
  },
) {
  const workspaceId = owner.workspaceId;
  const keyOf = (issue: Issue) => `${owner.teamIdentifier}-${issue.number}`;
  const pathOf = (issue: Issue) =>
    `/Users/ada/.vantik/worktrees/acme/storefront/${keyOf(issue).toLowerCase()}`;
  const branchOf = (issue: Issue) => `agent/${keyOf(issue).toLowerCase()}`;

  const localRun = async (
    issue: Issue,
    ompSessionId: string,
    fields: Record<string, unknown> & { startedAt: number },
    result: Record<string, unknown>,
    lines: Line[],
    session: Record<string, unknown>,
  ) => {
    const { startedAt, ...rest } = fields;
    const worktreePath = pathOf(issue);
    const branch = branchOf(issue);
    const id = await db.insert('AgentRun', {
      workspaceId,
      issueId: issue.id,
      agentUserId,
      createdById: owner.userId,
      executor: 'local',
      attempt: 1,
      config: LOCAL_CONFIG,
      harnessVersion: 'omp 18.8.6',
      createdAt: new Date(startedAt - 20_000),
      claimedAt: new Date(startedAt - 5_000),
      startedAt: new Date(startedAt),
      result: { worktreePath, branch, ompSessionId, ...result },
      ...rest,
    });
    // The session row the run was created with, after omp reported its own id.
    const sessionId = await db.insert('AgentSession', {
      workspaceId,
      issueId: issue.id,
      actorUserId: agentUserId,
      externalId: ompSessionId,
      harness: 'omp',
      location: 'LOCAL',
      channel: 'CONNECTOR',
      agentRunId: id,
      startedAt: new Date(startedAt - 5_000),
      ...session,
    });
    // The first line the local executor writes once omp has started.
    const events: Line[] = [
      [
        3,
        'setup',
        `omp started in ${worktreePath} on ${branch}`,
        { kind: 'session', ompSessionId, worktreePath, branch },
      ],
      ...lines,
    ];
    for (const [seconds, phase, message, data, level] of events) {
      await db.insert('AgentRunEvent', {
        runId: id,
        at: new Date(startedAt + seconds * 1000),
        level: level ?? 'INFO',
        phase,
        message,
        data: data ?? null,
      }, { updatedAt: false });
    }
    return { id, sessionId };
  };

  // Finished: the work is on a local branch, and the person went on with it.
  const doneStart = clockAt - 95 * MINUTE;
  const doneEnd = doneStart + 11 * MINUTE + 20_000;
  const promptAt = doneEnd + 40 * MINUTE;
  const replyAt = promptAt + 95_000;
  const secondsSince = (at: number) => (at - doneStart) / 1000;
  const done = await localRun(
    finishedIssue,
    '0e6b2a4c-7d1f-4c58-9a3e-5b8f21c4d9a7',
    {
      status: 'SUCCEEDED',
      startedAt: doneStart,
      finishedAt: new Date(doneEnd),
      modelId: LOCAL_CONFIG.model,
      iterationCount: 19,
      summary:
        'Added gift card redemption to checkout. A card is checked when the code is entered, applied before the card payment, and the rest of the total is charged as usual. Added tests for a card that covers the whole order and one that covers part of it.',
    },
    // The run's own $0.83 and 19 turns, plus the terminal turn that followed.
    {
      delivery: 'local-branch',
      headCommit: '3f9c1e2a64b7d08e5c1a9f2b7d3e6a40c8b15d97',
      costUsd: 0.95,
      turns: 20,
    },
    [
      [9, 'implement', 'Read src/checkout/payment-methods.tsx', { kind: 'read', target: 'src/checkout/payment-methods.tsx' }],
      [13, 'implement', 'Read src/payments/charge.ts', { kind: 'read', target: 'src/payments/charge.ts' }],
      [21, 'implement', 'Searched for giftCard', { kind: 'search', target: 'giftCard' }],
      [
        64,
        'implement',
        'Note',
        {
          kind: 'note',
          text: 'There is no gift card code in the repository yet. The charge takes one amount, so a card has to be taken off the total before the charge is made.',
        },
      ],
      [190, 'implement', 'Created src/payments/gift-card.ts', { kind: 'write', ref: 'w1', target: 'src/payments/gift-card.ts' }],
      [191, 'implement', 'Created src/payments/gift-card.ts', { ref: 'w1', ok: true, added: 58, removed: 0 }],
      [300, 'implement', 'Edit src/checkout/payment-methods.tsx', { kind: 'write', ref: 'w2', target: 'src/checkout/payment-methods.tsx' }],
      [301, 'implement', 'Edit src/checkout/payment-methods.tsx', { ref: 'w2', ok: true, added: 24, removed: 3 }],
      [470, 'implement', 'bash: pnpm test src/payments', { kind: 'test', ref: 'a1', command: 'pnpm test src/payments' }],
      [548, 'implement', 'Tests passed: 31', { kind: 'test', ref: 'a1', ok: true, passed: 31, failed: 0 }],
      [
        680,
        'report',
        `Left ${branchOf(finishedIssue)} at 3f9c1e2a in ${pathOf(finishedIssue)}`,
      ],
      // What the connector read from the session file after the run.
      [
        secondsSince(promptAt),
        'terminal',
        'Also show the remaining balance next to the gift card line in the order summary.',
        {
          kind: 'note',
          role: 'user',
          source: 'terminal',
          text: 'Also show the remaining balance next to the gift card line in the order summary.',
        },
      ],
      [
        secondsSince(replyAt),
        'terminal',
        'The order summary now shows the gift card line with the balance left after the order.',
        {
          kind: 'note',
          source: 'terminal',
          text: 'The order summary now shows the gift card line with the balance left after the order, for example "Gift card ($12.50 left)". I added a test for a card that covers only part of the total.',
        },
      ],
    ],
    {
      // A terminal holds the session. The connector renews the lease while it
      // watches, so the lease runs past the capture's clock.
      driver: 'TERMINAL',
      driverLeaseExpiresAt: new Date(clockAt + 10 * MINUTE),
      lastActiveAt: new Date(replyAt),
      terminalTurns: 1,
      terminalCostUsd: 0.12,
      terminalSeenAt: new Date(replyAt),
    },
  );

  // Working: Vantik drives it, and it waits on a person.
  const askStart = clockAt - 9 * MINUTE;
  const asking = await localRun(
    askingIssue,
    'b41d8e07-3a52-4f96-8c1d-6e9a07f3b2c5',
    {
      status: 'RUNNING',
      startedAt: askStart,
      iterationCount: 0,
      modelId: null,
    },
    { costUsd: 0.38, turns: 11 },
    [],
    {
      driver: 'VANTIK',
      driverLeaseExpiresAt: new Date(clockAt + 10 * MINUTE),
      lastActiveAt: new Date(askStart + 5 * MINUTE),
    },
  );
  const questionId = await db.insert('AgentQuestion', {
    workspaceId,
    issueId: askingIssue.id,
    agentRunId: asking.id,
    agentSessionId: asking.sessionId,
    externalId: 'redirect-scope',
    source: 'tool',
    questions: [
      {
        id: 'scope',
        prompt:
          'The blank page appears only after a 3-D Secure check. Should I fix that redirect only, or every redirect that follows a payment?',
        options: [
          {
            label: '3-D Secure only',
            description: 'The smallest change. The card-only path already works.',
          },
          {
            label: 'Every redirect after payment',
            description: 'Also changes the Apple Pay return, which has no test.',
          },
        ],
        allowOther: true,
      },
    ],
    status: 'OPEN',
    createdAt: new Date(askStart + 5 * MINUTE),
    // The server's clock is hours behind the capture's, so this stays open
    // while the capture runs, and reads as 25 minutes left in the browser.
    expiresAt: new Date(clockAt + 25 * MINUTE),
    assigneeId: owner.userId,
  });
  const askLines: Line[] = [
    [14, 'implement', 'Read web/src/checkout/return-url.ts', { kind: 'read', target: 'web/src/checkout/return-url.ts' }],
    [19, 'implement', 'Read web/src/checkout/confirmation.tsx', { kind: 'read', target: 'web/src/checkout/confirmation.tsx' }],
    [27, 'implement', 'Searched for threeDsReturn', { kind: 'search', target: 'threeDsReturn' }],
    [
      90,
      'implement',
      'Note',
      {
        kind: 'note',
        text: 'After a 3-D Secure check the provider sends the customer back with the order id in the hash. The confirmation page reads it from the query string, finds nothing and renders nothing.',
      },
    ],
    [
      300,
      'implement',
      'Asked a person: The blank page appears only after a 3-D Secure check.',
      { kind: 'question', agentQuestionId: questionId, status: 'OPEN' },
    ],
  ];
  for (const [seconds, phase, message, data] of askLines) {
    await db.insert('AgentRunEvent', {
      runId: asking.id,
      at: new Date(askStart + seconds * 1000),
      level: 'INFO',
      phase,
      message,
      data: data ?? null,
    }, { updatedAt: false });
  }

  return {
    localRunId: done.id,
    askingRunId: asking.id,
    askingQuestionId: questionId,
    localIssueKey: keyOf(finishedIssue),
  };
}

/** The first minute of every run, in the notes the hosted executor writes. */
function setup(): Line[] {
  return [
    [2, 'setup', 'Fetching the repository'],
    [9, 'setup', 'Starting the sandbox'],
    [40, 'setup', 'Preparing the sandbox'],
  ];
}

/**
 * A model key the workspace's runs use. The server checks a key against its
 * provider's catalogue before it stores it, so no made-up key passes for a
 * provider that has one. Azure has no catalogue to check against and is
 * stored as given, sealed under the server's key like a real one. The row is
 * then made to read as an Anthropic key whose catalogue was fetched, which is
 * what the model picker and the agent settings show.
 */
async function modelKey(api: APIRequestContext, db: Database, workspaceId: string) {
  await ok(
    await api.post('/v1/workspace_credentials', {
      data: {
        kind: 'MODEL_API_KEY',
        provider: 'azure-openai-responses',
        secret: 'docs-capture-not-a-real-key',
        baseUrl: 'https://docs.vantik.test',
      },
    }),
    'storing a model key',
  );
  await db.query(
    `UPDATE "WorkspaceCredential"
        SET provider = 'anthropic', "baseUrl" = NULL,
            models = $2::jsonb, "modelsCheckedAt" = now()
      WHERE "workspaceId" = $1 AND kind = 'MODEL_API_KEY'`,
    [workspaceId, JSON.stringify(MODELS)],
  );
  // The model runs use unless the person delegating picks another.
  await ok(
    await api.post('/v1/workspaces/preferences', {
      data: {
        agentRuns: {
          model: { provider: 'anthropic', model: MODELS[0].id, thinking: 'medium' },
        },
      },
    }),
    'choosing the default model',
  );
}

/**
 * The repository the web module's code is in. A repository belongs to a
 * connection, and both connections the API can make reach outside the stack:
 * a local checkout on the server's disk, or a git host. So the connection is
 * a row, as a local checkout would leave it, and the module is pointed at it
 * through the API.
 */
async function repository(
  api: APIRequestContext,
  db: Database,
  owner: Account,
  moduleId: string,
) {
  const repoId = randomUUID();
  const [definition] = await db.query<{ id: string }>(
    `SELECT id FROM "IntegrationDefinitionV2" WHERE slug = 'local-repo' AND deleted IS NULL`,
  );
  if (!definition) throw new Error('the server has no local-repo integration');

  const accountId = await db.insert('IntegrationAccount', {
    integrationConfiguration: {},
    accountId: owner.workspaceId,
    settings: {
      repositories: [
        {
          id: repoId,
          fullName: 'acme/storefront',
          path: '/srv/repos/storefront',
          addedAt: new Date().toISOString(),
        },
      ],
    },
    integratedById: owner.userId,
    integrationDefinitionId: definition.id,
    workspaceId: owner.workspaceId,
  });

  await ok(
    await api.post(`/v1/modules/${moduleId}/repos`, {
      data: {
        externalRepoId: repoId,
        fullName: 'acme/storefront',
        integrationAccountId: accountId,
        pathPrefixes: ['web/'],
        isDefault: true,
      },
    }),
    'linking the web module to its repository',
  );
}

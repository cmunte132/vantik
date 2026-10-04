import { randomUUID } from 'node:crypto';

import { type APIRequestContext } from '@playwright/test';

import { ok, type Issue } from '../src/api';
import type { Account } from '../src/auth';
import type { Database } from './db';

/**
 * What the agent pages show: a model the workspace can use, a repository the
 * storefront's code lives in, and runs on four issues, one in each state a
 * reader needs to recognise.
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
}

interface Input {
  owner: Account;
  /** The frozen clock the capture runs at, in ms. */
  clockAt: number;
  modules: { web: string; payments: string; catalog: string };
  issues: {
    running: Issue;
    succeeded: Issue;
    rejected: Issue;
    failed: Issue;
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
  { owner, clockAt, modules, issues }: Input,
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
    { status: 'RUNNING', startedAt: runningStart, iterationCount: 1 },
    [
      ...setup(),
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
      [300, 'verify', 'pnpm test src/payments', { kind: 'test', ref: 't1', command: 'pnpm test src/payments' }],
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
      iterationCount: 1,
      summary:
        'The address form re-rendered on every keystroke because the autofill handler replaced the whole form state, which dropped focus. It now merges the autofilled fields into the existing state. Added a test that autofills the form and checks the focused field keeps focus.',
      result: {
        delivery: 'pull_request',
        branch: 'vantik/eng-5-address-form-focus',
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
      [562, 'verify', 'pnpm test src/checkout', { kind: 'test', ref: 't1', command: 'pnpm test src/checkout' }],
      [640, 'verify', 'pnpm test src/checkout', { ref: 't1', ok: true, exit: 0, passed: 48, failed: 0 }],
      [683, 'verify', 'pnpm typecheck', { kind: 'bash', ref: 'b1', command: 'pnpm typecheck' }],
      [702, 'verify', 'pnpm typecheck', { ref: 'b1', ok: true, exit: 0 }],
      [825, 'review', 'The reviewer approved the change: the fix is the smallest one that keeps the inputs mounted, and the test fails without it.'],
      [852, 'report', 'Opened pull request #42 on acme/storefront'],
    ],
  );
  await db.insert('LinkedIssue', {
    url: 'https://github.com/acme/storefront/pull/42',
    sourceData: { source: 'agent-run', agentRunId: succeededRunId },
    createdById: owner.userId,
    issueId: issues.succeeded.id,
  });

  // Finished but not kept: a docs change has no test to hold it to, so it
  // went to a person, who rejected it and had the branch cleaned up.
  const rejectedStart = clockAt - DAY - 5 * 60 * MINUTE;
  const rejectedFinish = rejectedStart + 9 * MINUTE;
  const rejectedRunId = await run(
    issues.rejected,
    {
      status: 'NEEDS_REVIEW',
      failure: 'NOT_TEST_SPECIFIABLE',
      startedAt: rejectedStart,
      finishedAt: new Date(rejectedFinish),
      iterationCount: 1,
      summary:
        'Listed the eleven checkout events with their properties in docs/analytics/checkout.md. No test can check a document, so this needs a person to read it.',
      result: {
        delivery: 'pull_request',
        branch: 'vantik/eng-8-checkout-analytics-events',
        prUrl: 'https://github.com/acme/storefront/pull/43',
        headCommit: '4e0a2d1',
        filesChanged: 1,
        insertions: 96,
        deletions: 0,
        costUsd: 0.61,
        turns: 14,
        reviewPasses: 0,
        cleanedUp: {
          at: new Date(rejectedFinish + 3 * 60 * MINUTE).toISOString(),
          byUserId: owner.userId,
          pullRequest: 'closed',
          branch: 'deleted',
        },
      },
      phaseTimings: { setup: 61_000, implement: 402_000, report: 24_000 },
    },
    [
      ...setup(),
      [70, 'implement', 'Read src/analytics/events.ts', { kind: 'read', target: 'src/analytics/events.ts' }],
      [74, 'implement', 'Read src/checkout/track.ts', { kind: 'read', target: 'src/checkout/track.ts' }],
      [300, 'implement', 'Created docs/analytics/checkout.md', { kind: 'write', ref: 'w1', target: 'docs/analytics/checkout.md' }],
      [301, 'implement', 'Created docs/analytics/checkout.md', { ref: 'w1', ok: true, added: 96, removed: 0 }],
      [520, 'report', 'No executable test follows from the Definition of Done, so this is for a person to review'],
    ],
  );

  // Failed: the change broke two tests the run could not fix in its budget.
  const failedStart = clockAt - 4 * 60 * MINUTE;
  const failedRunId = await run(
    issues.failed,
    {
      status: 'FAILED',
      failure: 'VERIFICATION_FAILED',
      error:
        'pnpm test failed after 2 revise passes: 2 of 51 tests in src/catalog/stock.spec.ts still fail ("hides the badge when stock is unknown", "rounds stock above 99 to 99+").',
      startedAt: failedStart,
      finishedAt: new Date(failedStart + 22 * MINUTE),
      iterationCount: 3,
      result: {
        delivery: 'pull_request',
        branch: 'vantik/eng-9-stock-levels',
        prUrl: 'https://github.com/acme/storefront/pull/44',
        headCommit: '7f3e9a0',
        filesChanged: 3,
        insertions: 64,
        deletions: 12,
        costUsd: 2.84,
        turns: 41,
        reviewPasses: 0,
      },
      phaseTimings: {
        setup: 66_000,
        implement: 501_000,
        verify: 98_000,
        'revise-1': 240_000,
        'verify-2': 95_000,
        'revise-2': 220_000,
        'verify-3': 97_000,
      },
    },
    [
      ...setup(),
      [71, 'implement', 'Read src/catalog/product-page.tsx', { kind: 'read', target: 'src/catalog/product-page.tsx' }],
      [75, 'implement', 'Read src/catalog/stock.ts', { kind: 'read', target: 'src/catalog/stock.ts' }],
      [400, 'implement', 'Created src/catalog/stock-badge.tsx', { kind: 'write', ref: 'w1', target: 'src/catalog/stock-badge.tsx' }],
      [401, 'implement', 'Created src/catalog/stock-badge.tsx', { ref: 'w1', ok: true, added: 41, removed: 0 }],
      [1140, 'verify', 'pnpm test src/catalog', { kind: 'test', ref: 't1', command: 'pnpm test src/catalog' }],
      [
        1235,
        'verify',
        'pnpm test src/catalog',
        {
          ref: 't1',
          ok: false,
          exit: 1,
          passed: 49,
          failed: 2,
          output:
            'FAIL src/catalog/stock.spec.ts\n  ✕ hides the badge when stock is unknown\n  ✕ rounds stock above 99 to 99+\n\nTests: 2 failed, 49 passed, 51 total',
        },
        'ERROR',
      ],
      [1320, 'report', 'Verification still fails after 2 revise passes; stopping', undefined, 'ERROR'],
    ],
  );

  return { runningRunId, succeededRunId, rejectedRunId, failedRunId };
}

/** The first minute of every run: the sandbox, the clone and the install. */
function setup(): Line[] {
  return [
    [2, 'setup', 'Started a sandbox (2 vCPU, 4 GB)'],
    [9, 'setup', 'Cloned acme/storefront at main (3f2c9e1)'],
    [51, 'setup', 'Installed dependencies with pnpm in 41s'],
    [60, 'setup', 'Loaded 2 facts from the knowledge bank: Payments'],
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

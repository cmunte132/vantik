import { type APIRequestContext } from '@playwright/test';

import { ok, workflows, type Issue, type Label } from '../src/api';
import type { Account } from '../src/auth';

/**
 * The workspace the docs screenshots show: a small team building a web shop,
 * with enough in every part of the product that each page has something real
 * to show. Every record is made through the API, the way a person or an agent
 * makes it, so the seed breaks when the API does and never drifts from it.
 *
 * Titles and names are fixed. Each run makes a new workspace, so issue numbers
 * start at 1 every time and come out the same.
 */

export interface Seeded {
  /** Ids the capture needs to open pages directly. */
  projectId: string;
  /** Cycle URLs take the cycle's number in its team, not its id. */
  cycleNumber: number;
  pageId: string;
  productKey: string;
  moduleKey: string;
  capabilityId: string;
  viewId: string;
  /** The issue the issue-page screenshots open. */
  featuredIssueTitle: string;
}

/** Priorities as the API stores them. */
const PRIORITY = { none: 0, urgent: 1, high: 2, medium: 3, low: 4 };

const DAY = 24 * 60 * 60 * 1000;

interface People {
  owner: Account;
  grace: Account;
  alan: Account;
}

export async function seedWorkspace(
  api: APIRequestContext,
  people: People,
): Promise<Seeded> {
  const { owner, grace, alan } = people;
  const teamId = owner.teamId;

  const labels = await ok<Label[]>(
    await api.get('/v1/labels', { params: { workspaceId: owner.workspaceId } }),
    'listing labels',
  );
  const label = (name: string) => {
    const found = labels.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`the workspace has no "${name}" label`);
    return found.id;
  };
  const states = await workflows(api, teamId);
  const state = (name: string) => {
    const found = states.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`the team has no "${name}" state`);
    return found.id;
  };

  // Cycles are off until a team turns them on.
  await ok(
    await api.post(`/v1/teams/${teamId}/preferences`, {
      data: { cyclesEnabled: true, cyclesMode: 'manual' },
    }),
    'turning on cycles',
  );
  const now = Date.now();
  const cycle = await ok<{ id: string; number: number }>(
    await api.post('/v1/cycles/single', {
      data: {
        teamId,
        name: 'Checkout sprint',
        startDate: new Date(now - 3 * DAY).toISOString(),
        endDate: new Date(now + 11 * DAY).toISOString(),
      },
    }),
    'creating a cycle',
  );
  await ok(
    await api.post(`/v1/cycles/${cycle.id}/start`),
    'starting the cycle',
  );

  const project = await ok<{ id: string }>(
    await api.post('/v1/projects', {
      data: {
        name: 'New checkout',
        description:
          'Replace the three-step checkout with a single page that keeps the cart, address and payment together.',
        teams: [teamId],
        leadUserId: owner.userId,
        startDate: new Date(now - 10 * DAY).toISOString(),
        endDate: new Date(now + 40 * DAY).toISOString(),
      },
    }),
    'creating a project',
  );
  const beta = await ok<{ id: string }>(
    await api.post(`/v1/projects/${project.id}/milestone`, {
      data: { name: 'Private beta' },
    }),
    'creating a milestone',
  );
  await ok(
    await api.post(`/v1/projects/${project.id}/milestone`, {
      data: { name: 'General availability' },
    }),
    'creating a milestone',
  );

  // The product axis: one product, the modules that hold its code, and a
  // capability that lives in two of them.
  const product = await ok<{ id: string; key: string }>(
    await api.post('/v1/products', {
      data: {
        name: 'Storefront',
        key: 'storefront',
        description: 'The web shop customers buy from.',
      },
    }),
    'creating a product',
  );
  const module = async (name: string, key: string, description: string) =>
    ok<{ id: string; key: string }>(
      await api.post('/v1/modules', {
        data: { name, key, description, ownerProductId: product.id },
      }),
      `creating the ${name} module`,
    );
  const web = await module('Web app', 'web', 'The React storefront.');
  const payments = await module(
    'Payments service',
    'payments',
    'Takes card payments and talks to the payment provider.',
  );
  await module('Catalog service', 'catalog', 'Products, prices and stock.');
  const capability = await ok<{ id: string }>(
    await api.post('/v1/capabilities', {
      data: {
        name: 'Checkout',
        description: 'A customer pays for what is in their cart.',
        status: 'live',
        moduleIds: [web.id, payments.id],
      },
    }),
    'creating a capability',
  );

  const issue = async (
    title: string,
    fields: {
      state: string;
      priority?: keyof typeof PRIORITY;
      assignee?: Account;
      labels?: string[];
      parent?: Issue;
      inProject?: boolean;
      inCycle?: boolean;
      description?: string;
      modules?: string[];
    },
  ): Promise<Issue> =>
    ok<Issue>(
      await api.post('/v1/issues', {
        data: {
          title,
          teamId,
          stateId: state(fields.state),
          priority: PRIORITY[fields.priority ?? 'none'],
          assigneeId: fields.assignee?.userId,
          labelIds: (fields.labels ?? []).map(label),
          parentId: fields.parent?.id,
          descriptionMarkdown: fields.description,
          moduleIds: fields.modules,
          ...(fields.inProject
            ? { projectId: project.id, projectMilestoneId: beta.id }
            : {}),
          ...(fields.inCycle ? { cycleId: cycle.id } : {}),
          ...(fields.inProject ? { capabilityId: capability.id } : {}),
        },
      }),
      `creating "${title}"`,
    );

  const featuredIssueTitle = 'Keep the cart when a customer signs in';
  const featured = await issue(featuredIssueTitle, {
    state: 'In Progress',
    priority: 'high',
    assignee: owner,
    labels: ['Feature', 'Frontend'],
    inProject: true,
    inCycle: true,
    modules: [web.id],
    description: [
      'A customer who adds items while signed out loses them when they sign in. The cart is stored against the anonymous session and is not merged into the account.',
      '',
      '## Where it lives',
      '',
      '- `web/src/cart/use-cart.ts` reads the cart from the session.',
      '- The sign-in callback replaces the session without copying it.',
    ].join('\n'),
  });
  await issue('Merge the anonymous cart into the account cart', {
    state: 'Done',
    priority: 'high',
    assignee: owner,
    parent: featured,
    inProject: true,
    inCycle: true,
  });
  await issue('Show a notice when items could not be merged', {
    state: 'Todo',
    priority: 'medium',
    assignee: grace,
    parent: featured,
    inProject: true,
    inCycle: true,
  });

  const payment = await issue('Retry a declined card payment once', {
    state: 'In Review',
    priority: 'urgent',
    assignee: alan,
    labels: ['Backend'],
    inProject: true,
    inCycle: true,
    modules: [payments.id],
  });
  await issue('Address form loses focus on autofill', {
    state: 'Todo',
    priority: 'high',
    assignee: grace,
    labels: ['Bug', 'Frontend'],
    inProject: true,
    inCycle: true,
    modules: [web.id],
  });
  await issue('One-page checkout layout', {
    state: 'In Progress',
    priority: 'medium',
    assignee: grace,
    labels: ['Design'],
    inProject: true,
    inCycle: true,
  });
  await issue('Payment provider webhooks arrive twice', {
    state: 'Todo',
    priority: 'urgent',
    assignee: alan,
    labels: ['Bug', 'Backend'],
    modules: [payments.id],
  });
  await issue('Document the checkout events for analytics', {
    state: 'Backlog',
    priority: 'low',
    labels: ['Documentation'],
  });
  await issue('Show stock levels on the product page', {
    state: 'Backlog',
    priority: 'medium',
    labels: ['Feature'],
  });
  await issue('Gift cards at checkout', {
    state: 'Backlog',
    priority: 'low',
    labels: ['Feature'],
    inProject: true,
  });
  await issue('Order confirmation email shows the wrong currency', {
    state: 'Done',
    priority: 'high',
    assignee: alan,
    labels: ['Bug'],
    inCycle: true,
  });
  await issue('Customer reports a blank page after paying', {
    state: 'Triage',
    labels: ['Bug'],
  });

  // The featured issue blocks the payment retry.
  await ok(
    await api.post(`/v1/issues/${payment.id}`, {
      params: { teamId },
      data: {
        issueRelation: {
          type: 'BLOCKED',
          issueId: payment.id,
          relatedIssueId: featured.id,
        },
      },
    }),
    'relating two issues',
  );

  // A Definition of Done, part met.
  for (const [body, completed] of [
    ['A signed-out cart is merged into the account cart on sign-in', true],
    ['Items that are out of stock are dropped with a notice', false],
    ['The merge is covered by an end-to-end test', false],
  ] as const) {
    await ok(
      await api.post('/v1/checklist_items', {
        params: { issueId: featured.id },
        data: { body, completed },
      }),
      'adding a criterion',
    );
  }

  await ok(
    await api.post('/v1/issue_comments', {
      params: { issueId: featured.id },
      data: {
        bodyMarkdown:
          'The session id changes on sign-in, so the merge has to happen in the callback, before the old session is dropped.',
      },
    }),
    'commenting',
  );

  const view = await ok<{ id: string }>(
    await api.post('/v1/views', {
      data: {
        name: 'Urgent bugs',
        teamId,
        filters: {
          priority: { filterType: 'IS', value: [PRIORITY.urgent] },
        },
      },
    }),
    'creating a view',
  );

  const page = await ok<{ id: string }>(
    await api.post('/v1/pages', {
      data: {
        title: 'Payments',
        descriptionMarkdown: [
          'How the storefront takes payments, and what to know before you change it.',
          '',
          '## Flow',
          '',
          'The web app collects the card in the provider\'s hosted field. The payments service creates the charge and listens for the provider\'s webhooks.',
          '',
          '## Retries',
          '',
          'A declined card is retried once, after 30 seconds, and only for soft declines.',
        ].join('\n'),
      },
    }),
    'creating a page',
  );
  for (const content of [
    'Webhook handlers must be idempotent: the provider delivers some events more than once.',
    'Amounts are stored in minor units (cents) as integers, never as floats.',
  ]) {
    await ok(
      await api.post('/v1/page_entries', {
        params: { pageId: page.id },
        data: { content, kind: 'FACT' },
      }),
      'adding a page entry',
    );
  }

  return {
    projectId: project.id,
    cycleNumber: cycle.number,
    pageId: page.id,
    productKey: product.key,
    moduleKey: web.key,
    capabilityId: capability.id,
    viewId: view.id,
    featuredIssueTitle,
  };
}

import { readFileSync } from 'node:fs';

import { test as base, type APIRequestContext } from '@playwright/test';

import { bearer, type Account } from './auth';
import { ACCOUNTS_FILE, SERVER_URL } from './env';

/**
 * The people the setup project provisions once per run. Each owns a separate
 * workspace, which is what the tenancy tests need: two parties who must not be
 * able to see each other's records.
 */
export interface Accounts {
  alice: Account;
  bob: Account;
}

export function loadAccounts(): Accounts {
  try {
    return JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
  } catch (error) {
    throw new Error(
      `No accounts at ${ACCOUNTS_FILE}. They are written by the "setup" ` +
        `project, which every other project depends on; run the suite ` +
        `through \`pnpm e2e\` rather than a single project. (${error})`,
    );
  }
}

interface WorkerFixtures {
  accounts: Accounts;
}

interface TestFixtures {
  alice: Account;
  bob: Account;
  /** The API as Alice, authenticated with her personal access token. */
  asAlice: APIRequestContext;
  /** The API as Bob, who belongs to a different workspace. */
  asBob: APIRequestContext;
  /** The API with no credentials at all. */
  anonymous: APIRequestContext;
}

async function apiAs(
  playwright: { request: { newContext: (options: object) => Promise<APIRequestContext> } },
  token?: string,
): Promise<APIRequestContext> {
  return playwright.request.newContext({
    baseURL: SERVER_URL,
    extraHTTPHeaders: token ? bearer(token) : {},
  });
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  accounts: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use(loadAccounts());
    },
    { scope: 'worker' },
  ],

  alice: async ({ accounts }, use) => {
    await use(accounts.alice);
  },

  bob: async ({ accounts }, use) => {
    await use(accounts.bob);
  },

  asAlice: async ({ playwright, alice }, use) => {
    const api = await apiAs(playwright, alice.pat);
    await use(api);
    await api.dispose();
  },

  asBob: async ({ playwright, bob }, use) => {
    const api = await apiAs(playwright, bob.pat);
    await use(api);
    await api.dispose();
  },

  anonymous: async ({ playwright }, use) => {
    const api = await apiAs(playwright);
    await use(api);
    await api.dispose();
  },
});

export { expect } from '@playwright/test';

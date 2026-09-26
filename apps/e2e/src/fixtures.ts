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
  /**
   * A member of Alice's workspace who was invited to one team, CRL, and not to
   * Alice's own. Her account's `teamId` is CRL.
   */
  carol: Account;
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
  carol: Account;
  /** The API as Alice, authenticated with her personal access token. */
  asAlice: APIRequestContext;
  /** The API as Bob, who belongs to a different workspace. */
  asBob: APIRequestContext;
  /** The API as Carol, Alice's teammate in the CRL team only. */
  asCarol: APIRequestContext;
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

  carol: async ({ accounts }, use) => {
    await use(accounts.carol);
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

  asCarol: async ({ playwright, carol }, use) => {
    const api = await apiAs(playwright, carol.pat);
    await use(api);
    await api.dispose();
  },

  anonymous: async ({ playwright }, use) => {
    const api = await apiAs(playwright);
    await use(api);
    await api.dispose();
  },
});

/**
 * Marks the running test as a known bug: one that is on main and not yet
 * fixed. `test.fail` inverts the result, so the suite stays green while the bug
 * is there and goes red with "expected to fail, but passed" the moment it is
 * fixed, which is the prompt to delete the call.
 *
 * Call it after the test's own setup, never before. An inverted test passes
 * whatever makes it fail, so setup that broke underneath it would read as the
 * bug still being there. Once setup has run and been checked, the only thing
 * left to fail is the behaviour the test is about.
 */
export function knownBug(description: string) {
  test.fail(true, `Known bug on main: ${description}`);
}

export { expect } from '@playwright/test';

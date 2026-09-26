import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { expect, test as setup, type APIRequestContext } from '@playwright/test';

import { createSpareTeam } from '../src/api';
import { bearer, provisionAccount, provisionTeammate } from '../src/auth';
import {
  ACCOUNTS_FILE,
  MAILPIT_URL,
  runTag,
  SERVER_URL,
  WEBAPP_URL,
} from '../src/env';
import type { Accounts } from '../src/fixtures';

/** Status of a GET, or 0 while nothing is listening yet. */
async function statusOf(request: APIRequestContext, url: string) {
  try {
    return (await request.get(url, { timeout: 5_000 })).status();
  } catch {
    return 0;
  }
}

setup.describe.configure({ mode: 'serial' });

setup('the stack is up', async ({ request }) => {
  setup.setTimeout(240_000);

  // The server answers 503 here until every dependency answers, which is the
  // same check the compose healthcheck gates the webapp on.
  await expect
    .poll(() => statusOf(request, `${SERVER_URL}/health/ready`), {
      message: `server at ${SERVER_URL} never became ready`,
      timeout: 180_000,
      intervals: [1_000, 2_000, 5_000],
    })
    .toBe(200);

  await expect
    .poll(() => statusOf(request, `${WEBAPP_URL}/api/version`), {
      message: `webapp at ${WEBAPP_URL} never answered`,
      timeout: 60_000,
    })
    .toBe(200);

  await expect
    .poll(() => statusOf(request, `${MAILPIT_URL}/api/v1/messages?limit=1`), {
      message:
        `Mailpit at ${MAILPIT_URL} never answered. Start the stack with ` +
        `docker-compose.e2e.yaml, which adds it.`,
      timeout: 30_000,
    })
    .toBe(200);
});

setup('provision accounts', async ({ request, playwright }) => {
  const tag = runTag();

  const alice = await provisionAccount(request, {
    email: `alice+${tag}@e2e.vantik.test`,
    fullname: 'Alice',
    workspaceName: `E2E Alice ${tag}`,
    teamIdentifier: 'ALC',
  });

  const bob = await provisionAccount(request, {
    email: `bob+${tag}@e2e.vantik.test`,
    fullname: 'Bob',
    workspaceName: `E2E Bob ${tag}`,
    teamIdentifier: 'BOB',
  });

  // Carol joins Alice's workspace by invite, to a team of its own. Alice is in
  // both teams; Carol is in CRL only, which is what the team boundary tests
  // need: someone inside the workspace who must still not see ALC.
  const asAlice = await playwright.request.newContext({
    baseURL: SERVER_URL,
    extraHTTPHeaders: bearer(alice.pat),
  });
  const crl = await createSpareTeam(asAlice, { identifier: 'CRL' });
  await asAlice.dispose();

  const carol = await provisionTeammate(request, alice, {
    email: `carol+${tag}@e2e.vantik.test`,
    team: crl,
  });

  const accounts: Accounts = { alice, bob, carol };

  mkdirSync(dirname(ACCOUNTS_FILE), { recursive: true });
  writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
});

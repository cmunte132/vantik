import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { test as setup } from '@playwright/test';

import { createSpareTeam } from '../src/api';
import { bearer, provisionAccount, provisionTeammate } from '../src/auth';
import { ACCOUNTS_FILE, runTag, SERVER_URL } from '../src/env';
import type { Accounts } from '../src/fixtures';
import { waitForStack } from '../src/stack';

setup.describe.configure({ mode: 'serial' });

setup('the stack is up', async ({ request }) => {
  setup.setTimeout(240_000);
  await waitForStack(request);
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

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { expect, test as setup, type APIRequestContext } from '@playwright/test';

import { ok } from '../src/api';
import {
  bearer,
  provisionAccount,
  provisionTeammate,
} from '../src/auth';
import { signInInBrowser } from '../src/browser';
import { runTag, SERVER_URL } from '../src/env';
import { waitForStack } from '../src/stack';
import { Database } from './db';
import { DOCS_BROWSER_STATE, DOCS_RUN_FILE, type DocsRun } from './run';
import { seedWorkspace } from './seed';

const HOUR = 60 * 60 * 1000;

setup.describe.configure({ mode: 'serial' });

setup('the stack is up', async ({ request }) => {
  setup.setTimeout(240_000);
  await waitForStack(request);
});

setup('seed the docs workspace', async ({ request, playwright, page }) => {
  setup.setTimeout(180_000);
  const tag = runTag();

  // Workspace slugs are unique and come from the name, so the workspace is
  // made under a name of its own and renamed to the one the screenshots show.
  const owner = await provisionAccount(request, {
    email: `ada+${tag}@docs.vantik.test`,
    fullname: 'Ada Lovelace',
    workspaceName: `Acme ${tag}`,
    teamIdentifier: 'ENG',
    teamName: 'Engineering',
  });
  const api = await playwright.request.newContext({
    baseURL: SERVER_URL,
    extraHTTPHeaders: bearer(owner.pat),
  });
  await ok(
    await api.post('/v1/workspaces', {
      data: { name: 'Acme' },
    }),
    'renaming the workspace',
  );
  await ok(
    await api.put('/v1/users', { data: { username: 'ada' } }),
    'naming Ada',
  );

  const teammate = async (fullname: string, email: string) => {
    const account = await provisionTeammate(request, owner, {
      email: `${email}+${tag}@docs.vantik.test`,
      team: { id: owner.teamId, identifier: owner.teamIdentifier },
    });
    await ok(
      await request.put(`${SERVER_URL}/v1/users`, {
        headers: bearer(account.pat),
        // The username would otherwise be the per-run address's local part.
        data: { fullname, username: email },
      }),
      `naming ${fullname}`,
    );
    return account;
  };
  const grace = await teammate('Grace Hopper', 'grace');
  const alan = await teammate('Alan Turing', 'alan');

  // The capture's clock is frozen at the next whole hour but three, so that
  // anything made a moment ago reads as "3h ago" on every run. The seed dates
  // what has no creation time of its own, such as agent runs, from it too.
  const clockAt = Math.ceil((Date.now() + 3 * HOUR) / HOUR) * HOUR;

  // Ada's teammates act on her work through clients of their own, so what
  // they do lands in her inbox as it would from a person.
  const clients = new Map<string, APIRequestContext>();
  for (const person of [grace, alan]) {
    clients.set(
      person.userId,
      await playwright.request.newContext({
        baseURL: SERVER_URL,
        extraHTTPHeaders: bearer(person.pat),
      }),
    );
  }

  const db = await Database.connect();
  const seeded = await seedWorkspace(
    api,
    { owner, grace, alan },
    { db, clockAt, as: (person) => clients.get(person.userId)! },
  );
  await db.close();
  await api.dispose();
  for (const client of clients.values()) await client.dispose();

  await signInInBrowser(page, request, owner.email);
  await expect(page).toHaveURL(new RegExp(`/${owner.workspaceSlug}(/|$)`));

  const run: DocsRun = {
    owner,
    seeded,
    clockAt,
  };
  mkdirSync(dirname(DOCS_RUN_FILE), { recursive: true });
  writeFileSync(DOCS_RUN_FILE, JSON.stringify(run, null, 2));
  await page.context().storageState({ path: DOCS_BROWSER_STATE });
});

import { readFileSync } from 'node:fs';

import type { Account } from '../src/auth';
import type { Seeded } from './seed';

/** What the capture reads: who is signed in, and where the seeded records are. */
export interface DocsRun {
  owner: Account;
  seeded: Seeded;
  /**
   * The time the browser's clock is fixed to: a set while after the seed
   * finished. Relative times ("3 hours ago") then read the same on every run.
   */
  clockAt: number;
}

export const DOCS_RUN_FILE = `${__dirname}/../.auth/docs.json`;
export const DOCS_BROWSER_STATE = `${__dirname}/../.auth/docs.browser.json`;

export function loadDocsRun(): DocsRun {
  return JSON.parse(readFileSync(DOCS_RUN_FILE, 'utf8'));
}

/** Copyright (c) 2024, Vantik, all rights reserved. **/

/**
 * The rules that decide whether a client may reload itself without asking.
 *
 * Worth pinning because both directions fail quietly. A block that is never
 * claimed throws away an unsaved comment; a block that is never *released*
 * pins the client to an old build forever, and the only visible symptom is an
 * update chip that never resolves itself.
 *
 * Scope, stated plainly: this covers the guard's own contract, not the callers.
 * The bug that shipped was a composer passing a predicate that stayed true
 * after submit — one layer above anything here, and out of reach until the
 * suite can render components. So this narrows where such a bug can hide; it
 * does not close the gap.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  blockReload,
  hasReloadBlock,
  reloadBlockedReason,
} from './reload-guard';

/**
 * `reload-guard` reads exactly two things off the document, so stubbing them is
 * enough to run in the node environment the rest of the suite uses. Moving the
 * whole suite to jsdom would be a far larger change than these two properties
 * justify.
 *
 * `hidden: true` throughout: `lastInteractionAt` is initialised at import time,
 * so a visible document would report 'active' in every test and hide the branch
 * each one is actually about.
 */
function stubDocument({ overlay = false } = {}) {
  (globalThis as unknown as { document: unknown }).document = {
    hidden: true,
    querySelector: () => (overlay ? {} : null),
  };
}

const SAFE = { pendingMutations: 0 };

afterEach(() => {
  // A leaked block would silently pass its state to the next test, which is the
  // same failure mode being tested for.
  expect(hasReloadBlock()).toBe(false);
});

describe('reloadBlockedReason', () => {
  it('permits a silent reload when nothing is in the way', () => {
    stubDocument();

    expect(reloadBlockedReason(SAFE)).toBeUndefined();
  });

  it('holds while a block is claimed, and lets go the moment it is released', () => {
    stubDocument();

    const release = blockReload();
    expect(reloadBlockedReason(SAFE)).toBe('explicit-block');

    release();

    // The half that broke: the claim was correct, the release never happened,
    // so a client that had once opened a composer never reloaded again.
    expect(reloadBlockedReason(SAFE)).toBeUndefined();
  });

  it('counts overlapping blocks rather than tracking one flag', () => {
    stubDocument();

    const releaseFirst = blockReload();
    const releaseSecond = blockReload();

    releaseFirst();
    // Two composers can be open at once; the first one closing must not clear
    // the second one's claim.
    expect(reloadBlockedReason(SAFE)).toBe('explicit-block');

    releaseSecond();
    expect(reloadBlockedReason(SAFE)).toBeUndefined();
  });

  it('releases idempotently, so a double release cannot free another claim', () => {
    stubDocument();

    const releaseFirst = blockReload();
    releaseFirst();
    releaseFirst();

    const releaseSecond = blockReload();
    expect(reloadBlockedReason(SAFE)).toBe('explicit-block');

    releaseSecond();
  });

  it('reports an in-flight write ahead of everything else', () => {
    stubDocument({ overlay: true });

    const release = blockReload();

    // Ordering is the point: a write that has left the client but not landed is
    // the one thing a reload would lose outright.
    expect(reloadBlockedReason({ pendingMutations: 1 })).toBe(
      'mutation-in-flight',
    );

    release();
  });

  it('treats an open dialog as mid-task without the dialog opting in', () => {
    stubDocument({ overlay: true });

    expect(reloadBlockedReason(SAFE)).toBe('overlay-open');
  });
});

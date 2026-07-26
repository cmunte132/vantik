/** Copyright (c) 2024, Vantik, all rights reserved. **/

/**
 * When it is safe to reload without asking, and how to do it invisibly.
 *
 * The default for a stale client is a silent reload, not a prompt. A prompt is
 * the fallback for when a silent reload would interrupt something. Getting that
 * ordering right is the whole design: an update notice nobody has to act on is
 * worth more than one everybody dismisses.
 */

/** No input for this long counts as idle. */
const IDLE_AFTER_MS = 2 * 60 * 1000;

const RESTORE_KEY = 'vantik:reload-restore';

/**
 * How long a captured scroll position stays worth restoring. Long enough to
 * cover a reload, short enough that a position from an abandoned session is not
 * applied to a fresh one.
 */
const RESTORE_TTL_MS = 60 * 1000;

const INTERACTION_EVENTS = [
  'pointerdown',
  'keydown',
  'wheel',
  'touchstart',
] as const;

/**
 * Scroll containers worth restoring. The app scrolls inner elements rather than
 * the document, so restoring `window.scrollY` alone would put the user back at
 * the top of every list.
 */
const SCROLL_CONTAINER_SELECTOR =
  '[data-radix-scroll-area-viewport], .overflow-y-auto, .overflow-auto';

let lastInteractionAt = Date.now();
let listening = false;

/**
 * Held while something must not be interrupted — an editor with unsaved
 * changes, a form mid-entry. Reference-counted by token because several can
 * overlap.
 */
const reloadBlocks = new Set<symbol>();

function noteInteraction() {
  lastInteractionAt = Date.now();
}

/** Idempotent: called from a provider that may mount more than once. */
export function startInteractionTracking() {
  if (listening || typeof window === 'undefined') {
    return;
  }

  listening = true;

  for (const event of INTERACTION_EVENTS) {
    window.addEventListener(event, noteInteraction, { passive: true });
  }
}

export function stopInteractionTracking() {
  if (!listening || typeof window === 'undefined') {
    return;
  }

  listening = false;

  for (const event of INTERACTION_EVENTS) {
    window.removeEventListener(event, noteInteraction);
  }
}

/**
 * Claims a block on auto-reload. Call the returned function to release it.
 *
 * Nothing here reloads while a block is held, including the idle path — an
 * unsaved editor left open over lunch is exactly the case a timer would
 * otherwise get wrong.
 */
export function blockReload(): () => void {
  const token = Symbol('reload-block');
  reloadBlocks.add(token);

  return () => {
    reloadBlocks.delete(token);
  };
}

export function hasReloadBlock(): boolean {
  return reloadBlocks.size > 0;
}

/**
 * Radix renders open dialogs, alert dialogs and the command palette with these
 * roles, so this catches "the user is mid-task in an overlay" without every
 * overlay having to opt in.
 */
function hasOpenOverlay(): boolean {
  return Boolean(
    document.querySelector('[role="dialog"], [role="alertdialog"]'),
  );
}

export interface ReloadSafetyInput {
  /** From react-query; a write in flight must land before anything reloads. */
  pendingMutations: number;
}

export type ReloadBlockedReason =
  'mutation-in-flight' | 'explicit-block' | 'overlay-open' | 'active';

/**
 * Why a silent reload cannot happen right now, or undefined if it can.
 *
 * Returning the reason rather than a boolean keeps the caller able to say what
 * it is waiting for, which is the difference between a debuggable mechanism and
 * a mysterious one.
 */
export function reloadBlockedReason(
  input: ReloadSafetyInput,
): ReloadBlockedReason | undefined {
  if (input.pendingMutations > 0) {
    return 'mutation-in-flight';
  }

  if (hasReloadBlock()) {
    return 'explicit-block';
  }

  if (hasOpenOverlay()) {
    return 'overlay-open';
  }

  // A hidden tab is unconditionally safe: nobody is looking, and the reload
  // finishes before they are. Otherwise the user has to have stopped touching
  // it for a while.
  if (!document.hidden && Date.now() - lastInteractionAt < IDLE_AFTER_MS) {
    return 'active';
  }

  return undefined;
}

interface RestoreState {
  path: string;
  windowScroll: number;
  containers: Array<[index: number, scrollTop: number]>;
  at: number;
}

/**
 * Records where the user was, so the reload does not read as the app randomly
 * jumping to the top of the page.
 *
 * Containers are keyed by their index in document order. That is not robust
 * across a layout change — but a layout change means a different build, and
 * this state is only ever read once, moments later, by the build that replaced
 * it. A wrong scroll position is also a much smaller failure than a wrong
 * anything else, so approximate is the right trade here.
 */
function captureRestoreState() {
  const containers = Array.from(
    document.querySelectorAll(SCROLL_CONTAINER_SELECTOR),
  );

  const state: RestoreState = {
    path: window.location.pathname + window.location.search,
    windowScroll: window.scrollY,
    containers: containers
      .map((element, index) => [index, element.scrollTop] as [number, number])
      .filter(([, scrollTop]) => scrollTop > 0),
    at: Date.now(),
  };

  try {
    sessionStorage.setItem(RESTORE_KEY, JSON.stringify(state));
  } catch {
    // Scroll restoration is a nicety; a full sessionStorage must not stop the
    // reload it is decorating.
  }
}

/**
 * Puts the scroll positions back, if they belong to this page and are recent.
 *
 * Runs after mount, and retries on the next frames because the lists are
 * virtualised — the containers do not have their content, or their height, on
 * the first paint.
 */
export function restoreScrollAfterReload() {
  let raw: string | null = null;

  try {
    raw = sessionStorage.getItem(RESTORE_KEY);
  } catch {
    return;
  }

  if (!raw) {
    return;
  }

  try {
    sessionStorage.removeItem(RESTORE_KEY);
  } catch {
    // Best effort; a stale entry expires by TTL anyway.
  }

  let state: RestoreState;
  try {
    state = JSON.parse(raw) as RestoreState;
  } catch {
    return;
  }

  const currentPath = window.location.pathname + window.location.search;

  if (state.path !== currentPath || Date.now() - state.at > RESTORE_TTL_MS) {
    return;
  }

  let attempts = 0;

  const apply = () => {
    const containers = Array.from(
      document.querySelectorAll(SCROLL_CONTAINER_SELECTOR),
    );

    // Every captured container, not any one of them. Containers settle at
    // different rates — a sidebar has its content on the first frame, a
    // virtualised list does not — so stopping as soon as one succeeded left the
    // slow ones pinned at the top, which is precisely the jump this restores
    // against. Starts true so an empty capture needs no frames at all.
    let applied = true;

    for (const [index, scrollTop] of state.containers) {
      const element = containers[index];

      if (element && element.scrollHeight > scrollTop) {
        element.scrollTop = scrollTop;
      } else {
        applied = false;
      }
    }

    if (state.windowScroll > 0) {
      window.scrollTo({ top: state.windowScroll });
    }

    // Up to ~1s of frames. Virtualised lists settle within a few, and giving
    // up quietly is better than fighting a layout that genuinely changed.
    attempts += 1;
    if (!applied && attempts < 60) {
      requestAnimationFrame(apply);
    }
  };

  requestAnimationFrame(apply);
}

/**
 * Reloads onto whatever the server is serving now.
 *
 * `location.reload()` keeps the URL, so the route survives on its own and only
 * the scroll position needs carrying across.
 */
export function reloadIntoLatestBuild() {
  captureRestoreState();
  window.location.reload();
}

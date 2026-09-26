import * as React from 'react';
import { renderToString } from 'react-dom/server';

import {
  createStoreContext,
  StoreContext,
  type StoreContextInstanceType,
} from 'store/global-context-provider';

/**
 * Calls a hook once, inside the store provider, and returns what it returned.
 *
 * It renders to a string, so it runs in plain Node: no DOM, no jsdom. Context,
 * memos and MobX computeds all work. Effects never run, so this suits hooks
 * that derive something from the store, not ones that fetch or subscribe.
 */
export function renderHook<T>(
  hook: () => T,
  stores: StoreContextInstanceType = createStoreContext(),
): T {
  let result: T | undefined;

  function Probe(): null {
    result = hook();
    return null;
  }

  renderToString(
    <StoreContext.Provider value={stores}>
      <Probe />
    </StoreContext.Provider>,
  );

  return result as T;
}

/** Copyright (c) 2024, Vantik, all rights reserved. **/

import * as React from 'react';

import { blockReload } from 'common/lib/reload-guard';

/**
 * Holds off the silent auto-reload while `active` is true.
 *
 * Anything with state the user would lose should call this — an editor with
 * unsaved changes, a form part-way through. The reload does not disappear, it
 * waits: the moment the block is released and the window goes quiet, the update
 * lands on its own.
 *
 * The block is released on unmount, so a component that navigates away or
 * crashes cannot pin a client to an old build forever.
 */
export function useReloadBlock(active: boolean) {
  React.useEffect(() => {
    if (!active) {
      return undefined;
    }

    return blockReload();
  }, [active]);
}

/** Copyright (c) 2024, Vantik, all rights reserved. **/

'use client';

import { RiCloseLine, RiDownloadLine } from '@remixicon/react';
import { Button } from '@vantikhq/ui/components/button';
import { cn } from '@vantikhq/ui/lib/utils';
import * as React from 'react';

import { useAppVersion } from 'common/wrappers/app-version-provider';

/**
 * The fallback, not the mechanism.
 *
 * Most updates land silently while the window is idle or hidden, and this is
 * never shown. It appears only when a reload would interrupt something — an
 * unsaved editor, a write in flight, an open dialog — and it goes away on its
 * own if the moment passes and the silent path takes over.
 */
export function UpdateAvailableChip() {
  const { updateAvailable, overdue, reloadNow, dismiss } = useAppVersion();

  if (!updateAvailable) {
    return null;
  }

  return (
    <div
      role="status"
      className={cn(
        'fixed bottom-4 left-1/2 z-50 -translate-x-1/2',
        'flex items-center gap-2 rounded-lg border px-3 py-2 shadow-lg',
        'bg-background-3 text-sm',
        // Escalated only means harder to miss. It is still dismissible, and it
        // still blocks nothing — an old client is never cut off.
        overdue && 'border-primary shadow-primary/20',
      )}
    >
      <RiDownloadLine size={16} className="shrink-0 opacity-70" />

      <span>
        {overdue
          ? 'A newer version has been waiting a while'
          : 'A new version is available'}
      </span>

      <Button variant="secondary" size="sm" onClick={reloadNow}>
        Reload
      </Button>

      <Button
        variant="ghost"
        size="sm"
        onClick={dismiss}
        aria-label="Dismiss update notice"
      >
        <RiCloseLine size={14} />
      </Button>
    </div>
  );
}

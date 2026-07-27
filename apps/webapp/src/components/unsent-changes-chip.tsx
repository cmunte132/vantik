'use client';

import { RiUploadCloudLine } from '@remixicon/react';
import * as React from 'react';

import { useOutbox } from 'hooks/use-outbox';

/**
 * Says that a change has not reached the server yet.
 *
 * Almost never visible: writes are queued only when the request fails on the
 * network, and the queue drains as soon as it can. It matters when it does
 * appear, though — the alternative is an edit that looks saved because the
 * screen shows it, with nothing anywhere admitting the server has never heard
 * of it.
 *
 * Deliberately not an error. Nothing is lost and nothing needs doing; the
 * chip's whole message is "this is being carried, and something is carrying
 * it". It disappears on its own.
 */
export function UnsentChangesChip() {
  const { pending } = useOutbox();

  if (pending === 0) {
    return null;
  }

  return (
    <div
      role="status"
      className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-lg border bg-background-3 px-3 py-2 text-sm shadow-lg"
    >
      <RiUploadCloudLine size={16} className="text-muted-foreground" />
      <span>
        {pending === 1 ? '1 change' : `${pending} changes`} waiting to sync
      </span>
    </div>
  );
}

import { cn } from '@vantikhq/ui/lib/utils';
import React from 'react';

import { isLive } from './run-vocabulary';

/**
 * A run's state as a single mark.
 *
 * Every surface that mentions a run leads with this — the rail row, the
 * activity card, the runs list — so the colour of a run means the same thing
 * wherever it is seen, and a live one pulses everywhere or nowhere.
 */
export const StatusDot = ({
  status,
  className,
}: {
  status: string;
  className?: string;
}) => (
  <span
    className={cn(
      'size-2 shrink-0 rounded-full',
      isLive(status) && 'animate-pulse bg-primary',
      status === 'SUCCEEDED' && 'bg-green-500',
      status === 'NEEDS_REVIEW' && 'bg-amber-500',
      ['FAILED', 'EXPIRED'].includes(status) && 'bg-destructive',
      status === 'CANCELED' && 'bg-muted-foreground',
      className,
    )}
  />
);

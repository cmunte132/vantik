import * as React from 'react';

import { drainOutbox } from 'store/outbox-drain';
import { pendingWriteCount } from 'store/outbox';

/** How often to try again while something is stuck in the queue. */
const RETRY_INTERVAL_MS = 15_000;

/** How often to look for work when the queue is empty. */
const IDLE_INTERVAL_MS = 60_000;

/**
 * Drains queued writes and reports how many are waiting.
 *
 * Three triggers, because each covers a case the others miss: the browser's
 * `online` event catches a laptop waking up, the interval catches a server that
 * was down rather than a network that was, and the mount catches writes queued
 * in a previous session that the tab was closed on.
 */
export function useOutbox(): { pending: number } {
  const [pending, setPending] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const cycle = async (): Promise<void> => {
      const result = await drainOutbox().catch((): undefined => undefined);
      const count = await pendingWriteCount().catch(() => 0);

      if (cancelled) {
        return;
      }

      setPending(count);

      // Back off to a slow poll once there is nothing waiting: a queue that is
      // empty — which is almost always — should cost almost nothing.
      timer = setTimeout(
        cycle,
        result?.stalled || count > 0 ? RETRY_INTERVAL_MS : IDLE_INTERVAL_MS,
      );
    };

    const onOnline = () => {
      clearTimeout(timer);
      void cycle();
    };

    void cycle();
    window.addEventListener('online', onOnline);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener('online', onOnline);
    };
  }, []);

  return { pending };
}

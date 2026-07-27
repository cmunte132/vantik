import { ajaxPost } from 'services/utils';

import {
  type PendingWrite,
  forgetWrite,
  pendingWrites,
  recordAttempt,
} from './outbox';

/**
 * How many times a write is retried before it is dropped.
 *
 * A write that has failed this often is not failing for a reason time will fix,
 * and keeping it means retrying it on every reconnect forever.
 */
const MAX_ATTEMPTS = 20;

export interface DrainResult {
  sent: number;
  abandoned: number;
  /** Set when the network is still unavailable and the rest were left queued. */
  stalled: boolean;
}

/**
 * Whether a failed request is worth trying again.
 *
 * A response the server actually produced is an answer: a rejected field or a
 * permission failure will be rejected identically forever, so retrying is a
 * loop with a person's work stuck inside it. No response at all — or one the
 * server admits was its own fault — is the case this whole mechanism exists
 * for.
 */
export function isRetryable(error: {
  status?: number;
  errors?: { statusCode?: number };
}): boolean {
  const status = error?.status ?? error?.errors?.statusCode;

  if (!status) {
    return true;
  }

  // 408 and 429 are the server asking for the same request again later.
  return status >= 500 || status === 408 || status === 429;
}

/**
 * Sends everything the outbox is holding, oldest first.
 *
 * Order matters across records — a status change and a later comment on the
 * same issue should land in the order they were made — so a stalled write
 * stops the drain rather than letting later ones overtake it.
 */
export async function drainOutbox(): Promise<DrainResult> {
  const result: DrainResult = { sent: 0, abandoned: 0, stalled: false };

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    result.stalled = true;
    return result;
  }

  for (const write of await pendingWrites()) {
    try {
      await ajaxPost({ url: write.url, data: write.data });
      await forgetWrite(write.recordId);
      result.sent += 1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      if (!isRetryable(error)) {
        // The server has answered, and its answer will not change. Dropping it
        // loses the edit, which is bad — but holding it forever hides that the
        // edit was refused, which is worse.
        await forgetWrite(write.recordId);
        result.abandoned += 1;
        continue;
      }

      if (write.attempts + 1 >= MAX_ATTEMPTS) {
        await forgetWrite(write.recordId);
        result.abandoned += 1;
        continue;
      }

      await recordAttempt(write);
      result.stalled = true;
      break;
    }
  }

  return result;
}

export type { PendingWrite };

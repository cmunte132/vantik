import Dexie from 'dexie';

/**
 * A write that has not reached the server yet.
 *
 * Keyed by the record it changes rather than by when it was made, so repeated
 * edits to one issue collapse into a single entry. That is not only a size
 * optimisation: replaying "assign to A" then "assign to B" as two requests
 * makes the server briefly hold a state the user never asked to keep, and any
 * automation watching assignment sees a change that never really happened.
 */
export interface PendingWrite {
  /** The record being changed — the merge key. */
  recordId: string;
  url: string;
  /** Only the fields the user actually changed. */
  data: Record<string, unknown>;
  queuedAt: string;
  attempts: number;
}

class OutboxDatabase extends Dexie {
  writes: Dexie.Table<PendingWrite, string>;

  constructor(name: string) {
    super(name);

    this.version(1).stores({ writes: 'recordId,queuedAt' });

    this.writes = this.table('writes');
  }
}

let outbox: OutboxDatabase | undefined;

/**
 * Opens the outbox for a workspace/user.
 *
 * Deliberately a different database from the cache. A resync drops the cache
 * and rebuilds it from the server, which is the whole point of the resync —
 * and unsent work is the one thing that must not be thrown away by a
 * correctness measure. Keeping it here means the two can never be confused.
 */
export function initOutbox(hash: number) {
  outbox = new OutboxDatabase(`VantikOutbox_${hash}`);
}

export function outboxReady(): boolean {
  return Boolean(outbox);
}

/**
 * Records a write to send later, merging it into anything already queued for
 * the same record.
 *
 * Field-level last-write-wins falls out of the merge: each entry carries only
 * the fields the user changed, so two people editing different fields of the
 * same issue both keep their work, and the same field resolves to whoever
 * replayed last. Nothing here needs a version number or a conflict prompt,
 * because the window this covers is a hiccup rather than a day.
 */
export async function queueWrite(
  write: Omit<PendingWrite, 'queuedAt' | 'attempts'>,
): Promise<void> {
  if (!outbox) {
    return;
  }

  const existing = await outbox.writes.get(write.recordId);

  await outbox.writes.put(mergeWrite(existing, write));
}

/**
 * Folds a new change into whatever is already queued for the same record.
 *
 * Separated from the storage so the rule can be read and tested on its own —
 * it is the whole conflict policy in four lines.
 */
export function mergeWrite(
  existing: PendingWrite | undefined,
  incoming: Omit<PendingWrite, 'queuedAt' | 'attempts'>,
): PendingWrite {
  return {
    ...incoming,
    // Later values win per field, and fields nobody touched again survive.
    data: { ...(existing?.data ?? {}), ...incoming.data },
    // The original queue time, so drain order reflects when the user first
    // acted rather than when they last touched the same record.
    queuedAt: existing?.queuedAt ?? new Date().toISOString(),
    // Attempts belong to the record, not the edit: a write that has been
    // failing does not get a fresh budget because the user typed again.
    attempts: existing?.attempts ?? 0,
  };
}

export async function pendingWrites(): Promise<PendingWrite[]> {
  if (!outbox) {
    return [];
  }

  return outbox.writes.orderBy('queuedAt').toArray();
}

export async function pendingWriteCount(): Promise<number> {
  return outbox ? outbox.writes.count() : 0;
}

export async function forgetWrite(recordId: string): Promise<void> {
  await outbox?.writes.delete(recordId);
}

export async function recordAttempt(write: PendingWrite): Promise<void> {
  await outbox?.writes.put({ ...write, attempts: write.attempts + 1 });
}

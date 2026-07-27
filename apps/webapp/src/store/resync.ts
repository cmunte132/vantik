import { resetDatabase } from 'store/database';

/**
 * Rebuilds the local cache from scratch.
 *
 * The cache is incremental: a client stores a sequence and asks for everything
 * after it, which is only correct while every change produced a sync action and
 * every one of them was applied. When that stops being true — a restore, a
 * workspace copied between environments, a delta the server cannot serve from
 * the sequence this client holds — no further delta can put it right, because
 * the missing changes are all *behind* the sequence being asked from.
 *
 * Dropping the database and bootstrapping is authoritative by construction.
 * The alternative, pruning local records the bootstrap payload omits, needs a
 * rule about what the payload is allowed not to mention, and gets that rule
 * wrong quietly: prune too eagerly and it deletes real records, too timidly and
 * it leaves the phantom that prompted the resync. Re-downloading a workspace is
 * a cost worth paying for something that should happen rarely and has to be
 * right when it does.
 *
 * The reload is what makes it safe rather than clever: `initStore` re-runs from
 * scratch, sees no stored sequence, and takes the bootstrap path. Doing it in
 * place would mean re-hydrating every store while components hold references
 * into the ones being replaced.
 *
 * Anything that must survive this — queued writes that have not reached the
 * server — belongs in its own database, not in the cache being discarded.
 */
export async function resync(): Promise<void> {
  await resetDatabase();

  if (typeof window !== 'undefined') {
    window.location.reload();
  }
}

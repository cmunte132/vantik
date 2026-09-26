import React from 'react';

/**
 * How long typing has to pause before the knowledge bank is searched. The
 * same as issue search in the same box, so the two lists settle together.
 */
export const KNOWLEDGE_SEARCH_DELAY_MS = 500;

/**
 * Passes a query on only once it has stopped changing.
 *
 * Every knowledge search the server answers is recorded as demand: it bumps
 * the retrieval counts that rank entries and decide which ones survive decay,
 * and a search with no hits is written down as a knowledge gap. Searching on
 * every keystroke turned "redis eviction" into gaps for "r", "re", "red" and
 * so on, and counted each served entry once per letter. Only the query the
 * person actually settled on is a question anybody asked.
 *
 * Plain timers rather than a hook, so a test can drive it with fake ones.
 */
export function createSettledQuery(
  delayMs: number,
  onSettle: (query: string) => void,
): { update: (query: string) => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled: string | undefined;

  return {
    update(query: string) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // Typing a letter and deleting it again lands back on the query that
        // already settled; searching it a second time asks nothing new.
        if (query !== settled) {
          settled = query;
          onSettle(query);
        }
      }, delayMs);
    },
    cancel() {
      clearTimeout(timer);
    },
  };
}

/** The last value of `query` that held still for `delayMs`. */
export function useSettledQuery(query: string, delayMs: number): string {
  const [settled, setSettled] = React.useState(query);
  const settler = React.useMemo(
    () => createSettledQuery(delayMs, setSettled),
    [delayMs],
  );

  React.useEffect(() => {
    settler.update(query);
  }, [settler, query]);

  React.useEffect(() => () => settler.cancel(), [settler]);

  return settled;
}

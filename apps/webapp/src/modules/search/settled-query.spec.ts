import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSettledQuery, KNOWLEDGE_SEARCH_DELAY_MS } from './settled-query';

describe('createSettledQuery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('[KG-0.5] searches once, for the query typing settled on', () => {
    const search = vi.fn();
    const settler = createSettledQuery(KNOWLEDGE_SEARCH_DELAY_MS, search);

    // Typed a letter at a time, faster than the delay.
    for (const query of ['r', 're', 'red', 'redi', 'redis']) {
      settler.update(query);
      vi.advanceTimersByTime(100);
    }

    // Still inside the pause after the last keystroke: nothing has been asked.
    expect(search).not.toHaveBeenCalled();

    vi.advanceTimersByTime(KNOWLEDGE_SEARCH_DELAY_MS);

    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('redis');
  });

  it('[KG-0.5] waits the same 500 ms as issue search', () => {
    const search = vi.fn();
    const settler = createSettledQuery(KNOWLEDGE_SEARCH_DELAY_MS, search);

    settler.update('redis eviction');

    vi.advanceTimersByTime(499);
    expect(search).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(search).toHaveBeenCalledWith('redis eviction');
    expect(KNOWLEDGE_SEARCH_DELAY_MS).toBe(500);
  });

  it('[KG-0.5] does not search again for a query that already settled', () => {
    const search = vi.fn();
    const settler = createSettledQuery(KNOWLEDGE_SEARCH_DELAY_MS, search);

    settler.update('redis');
    vi.advanceTimersByTime(KNOWLEDGE_SEARCH_DELAY_MS);

    // A letter typed and deleted again, then a pause.
    settler.update('rediss');
    settler.update('redis');
    vi.advanceTimersByTime(KNOWLEDGE_SEARCH_DELAY_MS);

    expect(search).toHaveBeenCalledTimes(1);
  });

  it('[KG-0.5] searches nothing once cancelled, as when the dialog closes', () => {
    const search = vi.fn();
    const settler = createSettledQuery(KNOWLEDGE_SEARCH_DELAY_MS, search);

    settler.update('redis');
    settler.cancel();
    vi.advanceTimersByTime(KNOWLEDGE_SEARCH_DELAY_MS * 2);

    expect(search).not.toHaveBeenCalled();
  });
});

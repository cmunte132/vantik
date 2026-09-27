import { randomUUID } from 'node:crypto';

import { DEFAULT_KNOWLEDGE_SETTINGS } from 'modules/pages/knowledge-settings';

import { knowledgeArmFor } from './knowledge-arm';

/**
 * Which runs are held out from knowledge. The arm has to be the same every
 * time it is worked out for a run, and the share held out has to be the one
 * configured, or the comparison between the arms measures nothing.
 */
describe('the knowledge arm of a run', () => {
  const ids = Array.from(
    { length: 4000 },
    (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  );

  it('[KG-3.3] is the same whenever it is worked out for the same run', () => {
    for (const id of [...ids.slice(0, 50), randomUUID()]) {
      expect(knowledgeArmFor(id, 0.1)).toBe(knowledgeArmFor(id, 0.1));
    }
  });

  it('[KG-3.3] holds out about the configured share, ten percent by default', () => {
    expect(DEFAULT_KNOWLEDGE_SETTINGS.holdoutRate).toBe(0.1);

    const held = ids.filter((id) => knowledgeArmFor(id, 0.1) === 'HOLDOUT');
    // 4000 draws at p = 0.1: the mean is 400 and the standard deviation 19,
    // so this band is more than five of them wide on each side.
    expect(held.length).toBeGreaterThan(300);
    expect(held.length).toBeLessThan(500);

    const quarter = ids.filter((id) => knowledgeArmFor(id, 0.25) === 'HOLDOUT');
    expect(quarter.length).toBeGreaterThan(850);
    expect(quarter.length).toBeLessThan(1150);
  });

  it('[KG-3.3] holds out nothing at 0 and everything at 1', () => {
    expect(ids.every((id) => knowledgeArmFor(id, 0) === 'TREATMENT')).toBe(
      true,
    );
    expect(ids.every((id) => knowledgeArmFor(id, 1) === 'HOLDOUT')).toBe(true);
  });

  it('[KG-3.3] a run held out at a rate stays held out at any higher one', () => {
    // So raising the rate only moves runs from treatment to holdout, never
    // the other way.
    for (const id of ids.slice(0, 500)) {
      if (knowledgeArmFor(id, 0.1) === 'HOLDOUT') {
        expect(knowledgeArmFor(id, 0.3)).toBe('HOLDOUT');
      }
    }
  });
});

import { describe, expect, it } from 'vitest';

import { moveDetail } from './trail';

const titles: Record<string, string> = { a: 'Architecture', d: 'Deployment' };
const titleOf = (pageId: string | null) =>
  pageId ? titles[pageId] : 'no page';
const at = '2026-09-28T15:00:00.000Z';

describe('[ENG-227] a move on the trail of a fact', () => {
  it('says the fact lived outside pages, and that the gardener found the page', () => {
    expect(
      moveDetail(
        {
          createdAt: at,
          fromPageId: null,
          toPageId: 'd',
          movedById: 'u',
          suggested: true,
        },
        'apps/server',
        titleOf,
        'Chris',
      ),
    ).toBe(
      'It lived outside pages, scoped to apps/server. The gardener found a page it fits; Chris moved it · Sep 28',
    );
  });

  it('leaves the gardener out of a move a person chose', () => {
    expect(
      moveDetail(
        {
          createdAt: at,
          fromPageId: 'a',
          toPageId: 'd',
          movedById: null,
          suggested: false,
        },
        null,
        titleOf,
        null,
      ),
    ).toBe('It was on Architecture. A person moved it · Sep 28');
  });
});

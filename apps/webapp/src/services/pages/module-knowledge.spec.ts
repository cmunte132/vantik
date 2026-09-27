import { describe, expect, it } from 'vitest';

import { MODULE_KNOWLEDGE_LIMIT, moduleKnowledgeUrl } from './module-knowledge';

const query = (url: string) => new URL(url, 'http://vantik.test').searchParams;

describe('moduleKnowledgeUrl', () => {
  it('[KG-1.6] asks for standing entries only', () => {
    // A proposed or disputed claim under "Standing facts" would read as
    // knowledge the workspace accepted.
    expect(query(moduleKnowledgeUrl(['server'])).getAll('status')).toEqual([
      'STANDING',
    ]);
  });

  it('[KG-1.6] names every module, in a stable order', () => {
    expect(
      query(moduleKnowledgeUrl(['webapp', 'server'])).get('moduleIds'),
    ).toBe('server,webapp');
  });

  it('[KG-1.6] caps how many entries one screen fetches', () => {
    expect(query(moduleKnowledgeUrl(['server'])).get('limit')).toBe(
      String(MODULE_KNOWLEDGE_LIMIT),
    );
  });
});

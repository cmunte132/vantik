import { VantikError } from '@vantikhq/agent-core';

import { collectCitation, parseCitation } from './citations';

describe('a citation typed at a terminal', () => {
  it('[KG-2.1] reads code as path:lines, with an optional commit', () => {
    expect(parseCitation('apps/server/src/main.ts:40-52')).toEqual({
      path: 'apps/server/src/main.ts',
      lines: '40-52',
    });
    expect(parseCitation('src/a.ts:7@1a2b3c4')).toEqual({
      path: 'src/a.ts',
      lines: '7',
      sha: '1a2b3c4',
    });
  });

  it('[KG-2.1] reads where a decision was made', () => {
    expect(parseCitation('issue:ENG-42')).toEqual({ issue: 'ENG-42' });
    expect(parseCitation('pr:https://github.com/acme/api/pull/5')).toEqual({
      pullRequest: 'https://github.com/acme/api/pull/5',
    });
    expect(parseCitation('comment:c-1')).toEqual({ comment: 'c-1' });
    expect(parseCitation('run:r-1')).toEqual({ run: 'r-1' });
  });

  it('[KG-2.1] takes JSON for what the shorthand cannot say', () => {
    expect(
      parseCitation(
        '{"path": "a.ts", "lines": "3", "repo": "acme/api", "quote": "x"}',
      ),
    ).toEqual({ path: 'a.ts', lines: '3', repo: 'acme/api', quote: 'x' });
  });

  it('[KG-2.1] refuses what it cannot read, saying how to write it', () => {
    expect(() => parseCitation('src/a.ts')).toThrow(VantikError);
    expect(() => parseCitation('src/a.ts')).toThrow(/path:40-52/);
    expect(() => parseCitation('{nope')).toThrow(/not valid JSON/);
  });

  it('[KG-2.1] collects a repeated --cite in order', () => {
    expect(
      collectCitation('issue:ENG-1', collectCitation('src/a.ts:1', undefined)),
    ).toEqual([{ path: 'src/a.ts', lines: '1' }, { issue: 'ENG-1' }]);
  });
});

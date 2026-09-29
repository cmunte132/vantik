import { entryGroup } from 'modules/vector/vector.interface';

import {
  FIT_AT,
  MAKE_PAGE_AT,
  type LooseFact,
  type PageFit,
  sameFolder,
  suggestForLooseFacts,
} from './loose-facts.service';

const fact = (
  id: string,
  scope: string,
  moduleIds: string[] = [],
): LooseFact => ({ id, scope, moduleIds });

const page = (
  id: string,
  scopes: string[],
  moduleIds: string[] = [],
): PageFit => ({ id, title: `Page ${id}`, scopes, moduleIds });

describe('[ENG-227] the gardener for loose facts', () => {
  it('matches scopes by folder, not by prefix', () => {
    expect(sameFolder('apps/server', 'apps/server/prisma')).toBe(true);
    expect(sameFolder('apps/server/prisma', 'apps/server')).toBe(true);
    expect(sameFolder('apps/server', 'apps/server-extra')).toBe(false);
  });

  it('groups facts by the folder of their scope, the biggest group first', () => {
    const groups = suggestForLooseFacts(
      [
        fact('a', 'packages/ui'),
        fact('b', './apps/server/prisma/'),
        fact('c', 'apps/server/prisma/**/*.prisma'),
      ],
      [],
      new Map(),
    );

    expect(groups.map((group) => [group.scope, group.entryIds])).toEqual([
      ['apps/server/prisma', ['b', 'c']],
      ['packages/ui', ['a']],
    ]);
  });

  it('suggests a move under the page whose facts share the folder', () => {
    const [group] = suggestForLooseFacts(
      [fact('a', 'docker-compose.yaml')],
      [
        page('other', ['packages/ui', 'packages/ui/button']),
        page('deploy', ['docker-compose.yaml', 'docker-compose.yaml']),
      ],
      new Map(),
    );

    expect(group.suggestion).toEqual({
      kind: 'MOVE',
      pageId: 'deploy',
      title: 'Page deploy',
    });
  });

  it(`needs a score of ${FIT_AT}: one fact in the folder is not enough, one module link is`, () => {
    const one = suggestForLooseFacts(
      [fact('a', 'apps/server', ['m1'])],
      [page('thin', ['apps/server'])],
      new Map(),
    );
    const linked = suggestForLooseFacts(
      [fact('a', 'apps/server', ['m1'])],
      [page('thin', ['apps/server']), page('linked', [], ['m1'])],
      new Map(),
    );

    expect(one[0].suggestion.kind).toBe('NONE');
    expect(linked[0].suggestion).toMatchObject({
      kind: 'MOVE',
      pageId: 'linked',
    });
  });

  it(`suggests a new page, named after the shared module, at ${MAKE_PAGE_AT} facts`, () => {
    const facts = Array.from({ length: MAKE_PAGE_AT }, (_, index) =>
      fact(`f${index}`, 'apps/server/prisma', ['db', ...(index ? [] : ['x'])]),
    );

    const [group] = suggestForLooseFacts(
      facts,
      [],
      new Map([['db', 'Database and migrations']]),
    );

    expect(group.suggestion).toEqual({
      kind: 'MAKE_PAGE',
      pageId: null,
      title: 'Database and migrations',
    });
  });

  it('names a new page after the scope when the facts share no one module', () => {
    const facts = Array.from({ length: MAKE_PAGE_AT }, (_, index) =>
      fact(`f${index}`, 'scripts'),
    );

    const [group] = suggestForLooseFacts(facts, [], new Map());

    expect(group.suggestion).toEqual({
      kind: 'MAKE_PAGE',
      pageId: null,
      title: 'scripts',
    });
  });

  it('says no page fits yet below the threshold', () => {
    const [group] = suggestForLooseFacts(
      [fact('a', 'packages/ui')],
      [],
      new Map(),
    );

    expect(group.suggestion).toEqual({
      kind: 'NONE',
      pageId: null,
      title: null,
    });
  });

  it('groups a loose fact in the index by its scope, and a page fact by its page', () => {
    expect(entryGroup({ pageId: 'page-1', scope: 'apps/server' })).toBe(
      'page-1',
    );
    expect(entryGroup({ pageId: null, scope: 'apps/server' })).toBe(
      'scope:apps/server',
    );
  });
});

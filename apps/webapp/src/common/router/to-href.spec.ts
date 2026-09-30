/** Copyright (c) 2024, Vantik, all rights reserved. **/

import { describe, expect, it } from 'vitest';

import { toHref } from './index';

describe('toHref', () => {
  it('keeps a string as it is', () => {
    expect(toHref('/acme/issue/ENG-1?tab=pages')).toBe(
      '/acme/issue/ENG-1?tab=pages',
    );
  });

  it('fills the pattern segments from the query', () => {
    expect(
      toHref({
        pathname: '/[workspaceSlug]/issue/[issueId]',
        query: { workspaceSlug: 'acme', issueId: 'ENG-1' },
      }),
    ).toBe('/acme/issue/ENG-1');
  });

  it('puts the query keys the pattern does not use in the search string', () => {
    expect(
      toHref({
        pathname: '/[workspaceSlug]/pages/needs-you',
        query: { workspaceSlug: 'acme', subject: 'fact 1', empty: undefined },
      }),
    ).toBe('/acme/pages/needs-you?subject=fact+1');
  });

  it('repeats a key for each value of an array', () => {
    expect(
      toHref({ pathname: '/acme/all', query: { status: ['todo', 'done'] } }),
    ).toBe('/acme/all?status=todo&status=done');
  });

  it('turns numbers and booleans into strings', () => {
    expect(
      toHref({
        pathname: '/[workspaceSlug]/issue/[issueId]',
        query: { workspaceSlug: 'acme', issueId: 42, new: true },
      }),
    ).toBe('/acme/issue/42?new=true');
  });

  it('encodes a value that holds a slash in an ordinary segment', () => {
    expect(
      toHref({ pathname: '/[workspaceSlug]', query: { workspaceSlug: 'a/b' } }),
    ).toBe('/a%2Fb');
  });

  it('keeps the slashes of a catch-all segment', () => {
    expect(
      toHref({ pathname: '/docs/[...path]', query: { path: 'a/b c' } }),
    ).toBe('/docs/a/b%20c');
  });
});

/** Copyright (c) 2024, Vantik, all rights reserved. **/

import { describe, expect, it } from 'vitest';

import { workspaceHref } from './workspace-href';

describe('workspaceHref', () => {
  it('builds the ordinary path', () => {
    expect(workspaceHref('acme', 'product', 'cloud')).toBe(
      '/acme/product/cloud',
    );
  });

  it('takes the first value of a catch-all route', () => {
    expect(workspaceHref(['acme', 'ignored'], 'products')).toBe(
      '/acme/products',
    );
  });

  it('drops the parts that are not there', () => {
    expect(workspaceHref('acme', 'module', undefined, 'all')).toBe(
      '/acme/module/all',
    );
  });

  /**
   * The point of the helper. `/${slug}/rest` with an empty slug leaves
   * `//rest`, which a browser reads as protocol-relative and sends to a host
   * called `rest` — a link that leaves the origin while looking relative.
   */
  it('never produces a protocol-relative path', () => {
    for (const slug of ['', '   ', undefined, [] as string[]]) {
      const href = workspaceHref(slug, 'products');

      expect(href.startsWith('//')).toBe(false);
    }
  });

  it('sends a request with no workspace to the app root', () => {
    expect(workspaceHref(undefined, 'products')).toBe('/');
    expect(workspaceHref('', 'products')).toBe('/');
  });

  it('keeps a slug holding a slash to one segment', () => {
    expect(workspaceHref('/evil.com', 'products')).toBe(
      '/%2Fevil.com/products',
    );
    expect(workspaceHref('a/b', 'products')).toBe('/a%2Fb/products');
  });

  it('encodes a part so a name with a slash cannot add a segment', () => {
    expect(workspaceHref('acme', 'module', 'apps/server')).toBe(
      '/acme/module/apps%2Fserver',
    );
  });

  it('encodes a space rather than leaving it raw in the path', () => {
    expect(workspaceHref('acme', 'capability', 'Single sign on')).toBe(
      '/acme/capability/Single%20sign%20on',
    );
  });
});

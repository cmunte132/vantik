/** Copyright (c) 2024, Vantik, all rights reserved. **/

import { describe, expect, it } from 'vitest';

import { safeRedirectPath } from './safe-redirect';

describe('safeRedirectPath', () => {
  it('keeps the path somebody was trying to reach', () => {
    expect(safeRedirectPath('/acme/issues/ENG-1')).toBe('/acme/issues/ENG-1');
    expect(safeRedirectPath('/acme/issues?filter=open#top')).toBe(
      '/acme/issues?filter=open#top',
    );
    expect(safeRedirectPath('/')).toBe('/');
  });

  it('takes the first value when the parameter is repeated', () => {
    // `?redirectToPath=/a&redirectToPath=//evil.com` arrives as an array, and
    // the second value must not be the one that decides where somebody lands.
    expect(safeRedirectPath(['/acme/issues', '//evil.com'])).toBe(
      '/acme/issues',
    );
  });

  /**
   * The reason this exists. A sign-in page on this origin that forwards to
   * somebody else's site, at the moment a person has just proved who they are,
   * is a phishing primitive.
   */
  it('refuses a destination that leaves this origin', () => {
    expect(safeRedirectPath('https://evil.com')).toBe('/');
    expect(safeRedirectPath('http://evil.com')).toBe('/');
    // Protocol-relative: an ordinary-looking path that is a different host.
    expect(safeRedirectPath('//evil.com')).toBe('/');
    expect(safeRedirectPath('///evil.com')).toBe('/');
    // Browsers normalise a backslash to a slash, so this is the same attack
    // spelled differently.
    expect(safeRedirectPath('/\\evil.com')).toBe('/');
    expect(safeRedirectPath('/acme\\..\\evil.com')).toBe('/');
  });

  /** With a `javascript:` value it is not a redirect, it is script on this origin. */
  it('refuses a value that is not a path at all', () => {
    expect(safeRedirectPath('javascript:alert(1)')).toBe('/');
    expect(safeRedirectPath('JavaScript:alert(1)')).toBe('/');
    expect(safeRedirectPath('data:text/html,<script>alert(1)</script>')).toBe(
      '/',
    );
    expect(safeRedirectPath('acme/issues')).toBe('/');
  });

  it('sends a request with nothing to go back to at the app root', () => {
    expect(safeRedirectPath(undefined)).toBe('/');
    expect(safeRedirectPath(null)).toBe('/');
    expect(safeRedirectPath('')).toBe('/');
    expect(safeRedirectPath('   ')).toBe('/');
    expect(safeRedirectPath([])).toBe('/');
  });

  it('stays fast on a long value', () => {
    // The check runs on a value from the URL, so it has to stay linear. It is
    // three `startsWith`/`includes` calls now rather than a regular
    // expression, so there is nothing left to backtrack — this holds the next
    // person who reaches for one to the same bound.
    const started = Date.now();

    expect(safeRedirectPath(`/${'a/'.repeat(200_000)}x`)).toContain('/a/');
    expect(safeRedirectPath(`//${'a/'.repeat(200_000)}x`)).toBe('/');

    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

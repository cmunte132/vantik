import { describe, expect, it } from 'vitest';

import type { User } from 'common/types';

import { UNKNOWN_AUTHOR, authorName } from './comment-author';

/**
 * An issue page died on `sourceMetadata.userDisplayName` when a comment's
 * author could not be resolved: the renderer treated "no user" as proof that
 * the comment came from an integration, and integration comments are the only
 * ones guaranteed to carry `sourceMetadata`. The two conditions are unrelated,
 * and an agent posting a comment seconds after its account exists produces the
 * combination nothing handled — no user in the cached list, no sourceMetadata
 * either.
 */

function user(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    fullname: 'Chris Munte',
    username: 'chris',
    email: 'chris@munte.me',
    ...overrides,
  } as User;
}

describe('authorName', () => {
  it('names a resolved member', () => {
    expect(authorName(undefined, user())).toBe('Chris Munte');
  });

  it('does not throw when the author cannot be resolved and there is no source metadata', () => {
    // The regression. Anything but a throw is an improvement; a readable
    // placeholder is the point.
    expect(() => authorName(undefined, undefined)).not.toThrow();
    expect(authorName(undefined, undefined)).toBe(UNKNOWN_AUTHOR);
  });

  it('still credits an integration when the author is unresolved', () => {
    expect(
      authorName({ userDisplayName: 'Ada', type: 'slack' }, undefined),
    ).toBe('Ada via slack');
  });

  it('credits both when the integration comment maps to a known member', () => {
    expect(authorName({ userDisplayName: 'Ada', type: 'slack' }, user())).toBe(
      'Ada (Chris Munte)',
    );
  });

  it('falls back rather than printing "undefined" for a member with no name', () => {
    expect(authorName(undefined, user({ fullname: undefined }))).toBe(
      UNKNOWN_AUTHOR,
    );
  });
});

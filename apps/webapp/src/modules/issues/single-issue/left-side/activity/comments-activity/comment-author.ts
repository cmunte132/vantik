import type { IssueSourceMetadataType, User } from 'common/types';

import { getUserDetails } from '../issue-activity/user-activity-utils';

/**
 * What a parsed `comment.sourceMetadata` is worth assuming.
 *
 * The stored value is JSON of unknown shape, so every field is optional here
 * even though `IssueSourceMetadataType` declares some as required — treating a
 * parsed blob as a guaranteed shape is what produced the crash this module
 * exists to prevent.
 */
export type CommentSourceMetadata = Partial<IssueSourceMetadataType>;

/**
 * Who wrote this comment, given that the answer is sometimes unavailable.
 *
 * Three cases, and the third used to take the whole issue page down with it:
 * a workspace member, an integration comment carrying its own display name in
 * `sourceMetadata`, and an author the client cannot resolve at all. The last is
 * routine rather than exotic — the users list is fetched once per membership
 * set and cached, so an account that posts a comment moments after it is
 * created (which is exactly what a delegated agent does) is not in it yet, and
 * a removed member never will be. A comment worth reading should not be lost
 * because its author's name is not to hand.
 *
 * Lives apart from the component so the rule can be tested without a DOM.
 */
export function authorName(
  sourceMetadata: CommentSourceMetadata | undefined,
  user?: User,
): string {
  if (user) {
    return getUserDetails(sourceMetadata, user).fullname ?? UNKNOWN_AUTHOR;
  }

  if (sourceMetadata?.userDisplayName) {
    return `${sourceMetadata.userDisplayName} via ${sourceMetadata.type}`;
  }

  return UNKNOWN_AUTHOR;
}

export const UNKNOWN_AUTHOR = 'Unknown user';

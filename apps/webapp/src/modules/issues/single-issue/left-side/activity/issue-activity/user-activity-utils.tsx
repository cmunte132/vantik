import type { User } from 'common/types';
import type { IssueSourceMetadataType } from 'common/types';

export function getUserDetails(
  // Every caller passes a parsed JSON blob, and the body already treats each
  // field as maybe-absent — the signature was the only thing claiming
  // otherwise.
  sourceMetadata: Partial<IssueSourceMetadataType> | undefined,
  user?: User,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const name = sourceMetadata?.userDisplayName
    ? `${sourceMetadata.userDisplayName} (${user?.fullname})`
    : user?.fullname;

  return {
    fullname: name,
    username: user?.username,
  };
}

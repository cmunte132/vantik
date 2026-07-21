import * as cookie from 'cookie';

import { verifyAccessToken } from 'common/authentication';

import { SocketIdentity } from './sync.interface';

/**
 * Identifies the caller behind a websocket handshake, or returns null when the
 * handshake carries no usable session.
 *
 * This deliberately returns the identity rather than a boolean. The gateway
 * used to ask only whether *some* valid token was present and then join the
 * socket to rooms named by the query string, so a caller could name any
 * workspace and any user. The caller's own subject is the only safe basis for
 * that decision, so it has to come back out of here.
 */
export async function getAuthenticatedIdentity(
  headers: Record<string, string | string[]>,
): Promise<SocketIdentity | null> {
  if (!headers.cookie) {
    return null;
  }

  const cookies = cookie.parse(headers.cookie as string);

  if (!cookies?.sAccessToken) {
    return null;
  }

  const payload = await verifyAccessToken(`Bearer ${cookies.sAccessToken}`);

  // `sub` is the credential the session was minted for, not the account. The
  // account id rides in the payload, and binding a socket to anything else
  // would put someone in rooms keyed on an id no `User` row has.
  if (!payload?.appUserId) {
    return null;
  }

  return {
    userId: payload.appUserId as string,
    // The session's own workspace, used as the fallback when the handshake
    // does not name one. Membership is still checked before it is trusted.
    workspaceId: payload.workspaceId as string | undefined,
  };
}

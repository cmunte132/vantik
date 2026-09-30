import { AuthService, sessionTokenFromRequest } from 'modules/auth/auth.service';

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
  authService: AuthService,
): Promise<SocketIdentity | null> {
  const sessionToken = sessionTokenFromRequest({ headers });
  if (!sessionToken) {
    return null;
  }

  const session = await authService.resolveSession(sessionToken);
  if (!session) {
    return null;
  }

  const { appUserId, workspaceId, sessionId } = session.getAccessTokenPayload();
  return {
    userId: appUserId,
    // The session's own workspace, used as the fallback when the handshake
    // does not name one. Membership is still checked before it is trusted.
    workspaceId,
    sessionId,
  };
}

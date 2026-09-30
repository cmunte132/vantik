/** What the API reads from an authenticated context. */
export interface AuthSessionClaims {
  appUserId: string;
  workspaceId?: string;
  role?: string;
  tokenId?: string;
  /** The Session row of a browser session. A PAT context has none. */
  sessionId?: string;
}

/**
 * The one auth context for a request. A browser session and a personal access
 * token both supply it.
 */
export interface AuthSessionContext {
  getAccessTokenPayload(): AuthSessionClaims;
  getUserId(): string;
}

export function createAuthSessionContext(
  claims: AuthSessionClaims,
): AuthSessionContext {
  return {
    getAccessTokenPayload: () => claims,
    getUserId: () => claims.appUserId,
  };
}

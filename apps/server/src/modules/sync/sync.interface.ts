export interface ClientMetadata {
  workspaceId: string;
  userId: string;
  sessionId?: string;
}

/** The verified caller behind a websocket handshake. */
export interface SocketIdentity {
  userId: string;
  workspaceId?: string;
  sessionId?: string;
}

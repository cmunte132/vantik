export interface ClientMetadata {
  workspaceId: string;
  userId: string;
}

/** The verified caller behind a websocket handshake. */
export interface SocketIdentity {
  userId: string;
  workspaceId?: string;
}

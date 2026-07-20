import { IsOptional, IsString } from 'class-validator';

/**
 * `workspaceId` is optional and checked against the caller's memberships — a
 * user can belong to several workspaces, so the client names the one it wants.
 *
 * `userId` is deliberately absent: it decides which conversations and
 * notifications come back, and accepting it let any caller read another user's
 * by naming their id. It now comes from the session.
 */
export class BootstrapRequestQuery {
  @IsString()
  modelNames: string;

  @IsOptional()
  @IsString()
  workspaceId?: string;
}

export class DeltaRequestQuery {
  @IsString()
  modelNames: string;

  @IsString()
  lastSequenceId: string;

  @IsOptional()
  @IsString()
  workspaceId?: string;
}

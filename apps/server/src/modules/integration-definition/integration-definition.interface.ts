import { IsOptional, IsString } from 'class-validator';

/**
 * Query params for listing definitions.
 *
 * Kept separate from the shared `WorkspaceRequestParamsDto`, where
 * `workspaceId` is a required path param: here it is optional and checked
 * against the caller's memberships, falling back to the session's workspace.
 */
export class IntegrationDefinitionListQuery {
  @IsString()
  @IsOptional()
  workspaceId?: string;
}

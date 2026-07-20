import { Spec, WorkspaceRequestParamsDto } from '@vantikhq/types';
import { IsObject, IsOptional, IsString } from 'class-validator';

export class IntegrationDefinitionSpec {
  spec: Spec;
}

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

export class IntegrationDefinitionCreateBody extends WorkspaceRequestParamsDto {
  @IsObject()
  name: string;

  @IsString()
  icon: string;

  @IsString()
  clientId: string;

  @IsString()
  clientSecret: string;
}

export class IntegrationDefinitionUpdateBody {
  @IsOptional()
  @IsString()
  clientId: string;

  @IsOptional()
  @IsString()
  clientSecret: string;
}

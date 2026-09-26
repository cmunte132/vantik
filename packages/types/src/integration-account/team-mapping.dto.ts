import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * One route from something outside Vantik into a team.
 *
 * `source` is whatever the integration keys on: a repository id for GitHub, the
 * tag in an inbound address for email. One shape for both, so a workspace
 * account keeps one list in its settings and the settings page has one editor.
 */
export class TeamMapping {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  source: string;

  @IsString()
  @IsNotEmpty()
  teamId: string;
}

/** The whole list, replaced at once, the way the settings form saves it. */
export class UpdateTeamMappingsDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => TeamMapping)
  teamMappings: TeamMapping[];
}

/**
 * Connect an integration that has no third party to authorise.
 *
 * Bug Enricher is the case: it reaches nothing outside this server, so there is
 * no OAuth flow, and connecting it is only saying "run it for this workspace".
 */
export class ConnectIntegrationDto {
  @IsString()
  integrationDefinitionId: string;

  @IsString()
  workspaceId: string;
}

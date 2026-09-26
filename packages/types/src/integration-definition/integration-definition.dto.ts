import { IsString } from 'class-validator';

export class IntegrationDefinitionIdDto {
  @IsString()
  integrationDefinitionId: string;
}

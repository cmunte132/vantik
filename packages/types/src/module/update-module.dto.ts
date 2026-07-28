import { IsArray, IsOptional, IsString } from 'class-validator';

export class UpdateModuleDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  key?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @IsString()
  leadUserId?: string;

  /**
   * To move the owner, send the new owner and send null for the old one. The
   * server reads the row first and refuses a change that leaves the module with
   * two owners or with none.
   */
  @IsOptional()
  ownerTeamId?: string | null;

  @IsOptional()
  ownerProductId?: string | null;

  @IsOptional()
  @IsArray()
  linkedTeamIds?: string[];

  @IsOptional()
  @IsArray()
  linkedProductIds?: string[];
}

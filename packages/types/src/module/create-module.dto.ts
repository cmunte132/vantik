import { IsArray, IsOptional, IsString } from 'class-validator';

export class CreateModuleDto {
  @IsString()
  name: string;

  /**
   * A short name, for example "webapp". The server makes one from the name if
   * the caller sends none.
   */
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
   * Send ownerTeamId or ownerProductId. Do not send both, and do not leave both
   * empty. The server refuses the request in either case, and a check constraint
   * in the database refuses the row.
   */
  @IsOptional()
  @IsString()
  ownerTeamId?: string;

  @IsOptional()
  @IsString()
  ownerProductId?: string;

  @IsOptional()
  @IsArray()
  linkedTeamIds?: string[];

  @IsOptional()
  @IsArray()
  linkedProductIds?: string[];
}

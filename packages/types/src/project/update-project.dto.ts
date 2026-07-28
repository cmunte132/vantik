import { IsArray, IsOptional, IsString } from 'class-validator';

export class UpdateProjectDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;

  @IsOptional()
  @IsString()
  leadUserId?: string;

  @IsOptional()
  @IsArray()
  teams?: string[];

  /** The capabilities this project builds or changes. Replaces the list. */
  @IsOptional()
  @IsArray()
  capabilityIds?: string[];
}

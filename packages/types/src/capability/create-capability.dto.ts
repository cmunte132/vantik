import { IsArray, IsOptional, IsString } from 'class-validator';

export class CreateCapabilityDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  /** planned, active, live, or deprecated. Defaults to planned. */
  @IsOptional()
  @IsString()
  status?: string;

  /**
   * The modules that hold the code. The list can be empty, which means that no
   * team wrote this capability yet.
   */
  @IsOptional()
  @IsArray()
  moduleIds?: string[];
}

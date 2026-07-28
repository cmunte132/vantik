import { IsArray, IsOptional, IsString } from 'class-validator';

export class UpdateCapabilityDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsArray()
  moduleIds?: string[];
}

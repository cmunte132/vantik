import { IsArray, IsOptional, IsString } from 'class-validator';

export class CreateProjectDto {
  @IsString()
  name: string;

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

  /**
   * The capabilities this project builds or changes. The list can be empty.
   *
   * A project says which objective the work serves, and a capability says what
   * the software will do because of it. Naming them here is what lets a person
   * ask what a capability cost, rather than only which issues mentioned it.
   */
  @IsOptional()
  @IsArray()
  capabilityIds?: string[];
}

import { IsDateString, IsOptional, IsString } from 'class-validator';

/**
 * One cycle, created by hand.
 *
 * Dates are required rather than optional because the schema stores them
 * non-null, and a cycle with no dates is a cycle that can never end. The
 * alternative — migrating the columns to nullable so the UI can create a
 * half-formed cycle — buys nothing the create dialog cannot supply.
 */
export class CreateCycleDto {
  @IsString()
  teamId: string;

  @IsString()
  name: string;

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsOptional()
  @IsString()
  description?: string;
}

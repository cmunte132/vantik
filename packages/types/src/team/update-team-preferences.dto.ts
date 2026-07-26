import { IsBoolean, IsEnum, IsNumber, IsOptional } from 'class-validator';

import { CyclesModeEnum } from './team.dto';
import { UnfinishedDestinationEnum } from '../cycle/complete-cycle.dto';

export enum TeamType {
  ENGINEERING = 'engineering',
  SUPPORT = 'support',
}

export class UpdateTeamPreferencesDto {
  @IsOptional()
  @IsBoolean()
  cyclesEnabled?: boolean;

  @IsOptional()
  @IsEnum(CyclesModeEnum)
  cyclesMode?: CyclesModeEnum;

  @IsOptional()
  @IsEnum(UnfinishedDestinationEnum)
  autoRolloverDestination?: UnfinishedDestinationEnum;

  @IsOptional()
  @IsNumber()
  cyclesFrequency?: number; // Number of Weeks

  @IsOptional()
  @IsNumber()
  upcomingCycles?: number; // Number of cycles to create

  @IsOptional()
  @IsEnum(TeamType)
  teamType?: TeamType;
}

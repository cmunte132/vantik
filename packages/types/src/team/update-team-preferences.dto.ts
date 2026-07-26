import { IsBoolean, IsEnum, IsNumber, IsOptional } from 'class-validator';

import { CyclesModeEnum } from './team.dto';

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
  @IsNumber()
  cyclesFrequency?: number; // Number of Weeks

  @IsOptional()
  @IsNumber()
  upcomingCycles?: number; // Number of cycles to create

  @IsOptional()
  @IsEnum(TeamType)
  teamType?: TeamType;
}

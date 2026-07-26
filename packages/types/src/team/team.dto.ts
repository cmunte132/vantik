import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

export class TeamRequestParamsDto {
  @IsString()
  teamId: string;
}

/**
 * How a team's cycles are driven.
 *
 * `AUTO` is the Linear shape: a cadence is configured once and the system
 * creates, closes and rolls cycles forward on its own. `MANUAL` is the Jira
 * shape: a person creates each cycle and decides when it starts and ends, and
 * where its unfinished work goes. The distinction is not cosmetic — it decides
 * whether the close schedule is allowed to touch the team at all.
 */
export enum CyclesModeEnum {
  AUTO = 'auto',
  MANUAL = 'manual',
}

/**
 * The mode a team with cycles enabled runs in when it has never picked one.
 *
 * Manual, because it is the mode that does nothing without being asked. A team
 * that enabled cycles and was silently defaulted into automation would find
 * cycles opening and closing on a cadence nobody chose.
 */
export const DEFAULT_CYCLES_MODE = CyclesModeEnum.MANUAL;

/** Cadence defaults the seeder and the settings form both start from. */
export const DEFAULT_CYCLES_FREQUENCY = 2;
export const DEFAULT_UPCOMING_CYCLES = 2;

export class TeamPreferenceDto {
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
  @IsBoolean()
  triage?: boolean;
}

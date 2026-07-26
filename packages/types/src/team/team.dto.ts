import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

import { UnfinishedDestinationEnum } from '../cycle/complete-cycle.dto';

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

  /**
   * Whether the automatic cadence is currently running for this team.
   *
   * Set by Start, cleared by Stop. Recorded explicitly rather than inferred
   * from the cycle rows, because the two states are indistinguishable from the
   * rows alone: a team that was stopped mid-cycle has a running cycle and no
   * upcoming ones, which is exactly what a team about to be topped up looks
   * like. Inferring it would have the schedule undo every Stop on its next
   * pass.
   */
  @IsOptional()
  @IsBoolean()
  cyclesAutoRunning?: boolean;

  /**
   * Where the schedule sends unfinished issues when it closes a cycle. Only
   * consulted in automatic mode; manual completions are asked each time.
   */
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
  @IsBoolean()
  triage?: boolean;
}

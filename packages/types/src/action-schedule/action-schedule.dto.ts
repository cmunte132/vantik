import { IsEnum, IsOptional, IsString } from 'class-validator';

import { ActionScheduleStatusEnum } from './action-schedule.entity';

export class ActionScheduleParamsDto {
  @IsString()
  actionSlug: string;

  @IsString()
  actionScheduleId: string;
}

export class ActionScheduleDto {
  @IsString()
  cron: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsEnum(ActionScheduleStatusEnum)
  status?: ActionScheduleStatusEnum;
}

export class ActionScheduleTriggerParamsDto {
  actionId: string;
  actionEntityId: string;
}

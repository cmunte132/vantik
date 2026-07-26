import { IsEnum } from 'class-validator';

/**
 * Where a cycle's unfinished issues go when it completes.
 *
 * There is no third option and no default here on purpose: work that was in a
 * cycle nobody finished has to land somewhere, and leaving it pinned to a
 * completed cycle — what the system did before this existed — is the one
 * outcome that is always wrong.
 */
export enum UnfinishedDestinationEnum {
  NEXT_CYCLE = 'next-cycle',
  BACKLOG = 'backlog',
}

export class CompleteCycleDto {
  @IsEnum(UnfinishedDestinationEnum)
  unfinishedDestination: UnfinishedDestinationEnum;
}

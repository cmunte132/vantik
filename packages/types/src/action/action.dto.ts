import { IsString } from 'class-validator';

export class ActionIdDto {
  @IsString()
  actionId: string;
}

export class ActionSlugDto {
  @IsString()
  slug: string;
}

export class ActionRunDto {
  runId: string;
}

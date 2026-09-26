import { IsString } from 'class-validator';

export class CodeDto {
  @IsString()
  code: string;
}

export class CodeDtoWithWorkspace {
  @IsString()
  code: string;

  @IsString()
  workspaceId: string;
}

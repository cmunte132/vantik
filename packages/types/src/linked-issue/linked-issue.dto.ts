import { IsString } from 'class-validator';

export class LinkedIssueRequestParamsDto {
  @IsString()
  linkedIssueId: string;
}

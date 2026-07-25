import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';

export class CreateChecklistItemDto {
  @IsString()
  body: string;

  @IsOptional()
  @IsBoolean()
  completed?: boolean;

  @IsOptional()
  @IsNumber()
  sortOrder?: number;
}

export class CreateChecklistItemRequestParamsDto {
  @IsString()
  issueId: string;
}

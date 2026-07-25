import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';

export class UpdateChecklistItemDto {
  @IsOptional()
  @IsString()
  body?: string;

  @IsOptional()
  @IsBoolean()
  completed?: boolean;

  @IsOptional()
  @IsNumber()
  sortOrder?: number;
}

export class ChecklistItemRequestParamsDto {
  @IsString()
  checklistItemId: string;
}

import { IsObject, IsOptional, IsString } from 'class-validator';

export class UpdateTemplateDto {
  @IsOptional()
  @IsString()
  name?: string;

  // TODO: Manoj change this when you have finalised the issue thing
  @IsOptional()
  @IsObject()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  templateData?: Record<string, any>;
}

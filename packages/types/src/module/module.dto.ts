import { IsString } from 'class-validator';

export class ModuleRequestParamsDto {
  @IsString()
  moduleId: string;
}

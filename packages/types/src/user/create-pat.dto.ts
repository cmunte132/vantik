import { IsString } from 'class-validator';

export class CreatePatDto {
  @IsString()
  name: string;
}

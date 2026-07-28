import { IsString } from 'class-validator';

export class CapabilityRequestParamsDto {
  @IsString()
  capabilityId: string;
}

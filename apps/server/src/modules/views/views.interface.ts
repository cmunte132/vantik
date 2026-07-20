import { FilterTypeEnum } from '@vantikhq/types';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDefined,
  IsEnum,
  IsNotEmptyObject,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export interface ViewsRequestBody {
  /**
   * Optional. Honoured only if the caller is an active member of it, otherwise
   * the request is rejected. Falls back to the session's workspace when absent.
   */
  workspaceId?: string;
}
export class FilterModelType {
  @IsArray()
  @Type(() => String)
  value: string[];

  @IsEnum(FilterTypeEnum)
  filterType: FilterTypeEnum;
}

export class FiltersModelType {
  [key: string]: FilterModelType;
}

export class CreateViewsRequestBody {
  @IsDefined()
  @IsNotEmptyObject()
  @IsObject()
  @ValidateNested()
  @Type(() => FiltersModelType)
  filters: FiltersModelType;

  /**
   * Optional. Checked against the caller's memberships before the view is
   * created — this used to be trusted, which let a caller create views inside
   * a workspace they have no part in.
   */
  @IsString()
  @IsOptional()
  workspaceId?: string;

  @IsString()
  @IsOptional()
  teamId?: string;

  @IsString()
  name: string;

  @IsString()
  @IsOptional()
  description?: string;
}

export class UpdateViewsRequestBody {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsDefined()
  @IsNotEmptyObject()
  @IsObject()
  @ValidateNested()
  @Type(() => FiltersModelType)
  filters?: FiltersModelType;

  @IsBoolean()
  @IsOptional()
  isBookmarked?: boolean;
}

export class ViewRequestIdBody {
  @IsString()
  viewId: string;
}

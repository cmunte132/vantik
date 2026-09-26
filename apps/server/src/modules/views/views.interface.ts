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
} from 'class-validator';
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
  // Not @ValidateNested. The keys are field names, so class-validator sees no
  // property on the nested class, and under `whitelist` a nested class with
  // none loses every key: the view would be saved with no filters at all.
  @IsDefined()
  @IsNotEmptyObject()
  @IsObject()
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

  // Not @ValidateNested, for the reason on `CreateViewsRequestBody.filters`.
  @IsDefined()
  @IsNotEmptyObject()
  @IsObject()
  filters?: FiltersModelType;

  @IsBoolean()
  @IsOptional()
  isBookmarked?: boolean;
}

export class ViewRequestIdBody {
  @IsString()
  viewId: string;
}

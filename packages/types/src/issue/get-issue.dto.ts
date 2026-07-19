import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

import { FilterKey, FilterValue } from '../view';

export enum IssueViewEnum {
  /** Lean rows: ids, key, title and state — no description. */
  LIST = 'list',
  /** Every issue column, plus `descriptionMarkdown`. */
  FULL = 'full',
}

export enum IssueOrderByEnum {
  updatedAt = 'updatedAt',
  createdAt = 'createdAt',
  number = 'number',
  priority = 'priority',
}

export const DEFAULT_ISSUES_PER_PAGE = 50;
export const MAX_ISSUES_PER_PAGE = 200;

export class GetIssuesByFilterDTO {
  @IsObject()
  filters: {
    [K in FilterKey]?: FilterValue;
  };

  @IsString()
  workspaceId: string;

  /**
   * Pagination and lean payloads are opt-in: with none of `page`, `perPage`,
   * `orderBy` or `view` set the endpoint keeps returning a bare array of full
   * issues, which is what existing clients expect.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ISSUES_PER_PAGE)
  perPage?: number;

  @IsOptional()
  @IsEnum(IssueOrderByEnum)
  orderBy?: IssueOrderByEnum;

  @IsOptional()
  @IsEnum(IssueViewEnum)
  view?: IssueViewEnum;
}

export class GetIssuesByNumberDTO {
  @IsNumber()
  number: number;
}

export interface IssueListItem {
  id: string;
  key: string;
  title: string;
  stateId: string;
  stateCategory: string | null;
  assigneeId: string | null;
  priority: number | null;
  labelIds: string[];
  projectId: string | null;
  updatedAt: Date;
}

export interface PaginatedIssues<T> {
  issues: T[];
  page: number;
  perPage: number;
  total: number;
}

import { Transform, Type } from 'class-transformer';
import {
  IsArray,
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

/**
 * Query params for `GET /v1/issues`.
 *
 * Both fields narrow the result set; neither widens it. The workspace is always
 * taken from the caller's session, so an unfiltered request returns that
 * workspace's issues and nothing else.
 */
export class GetIssuesQueryDto {
  /**
   * Repeated (`?issueIds=a&issueIds=b`) or comma-separated. A single value
   * arrives as a bare string, so normalise to an array before validating.
   */
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined || value === null
      ? undefined
      : (Array.isArray(value) ? value : String(value).split(','))
          .map((id: string) => id.trim())
          .filter(Boolean),
  )
  @IsArray()
  @IsString({ each: true })
  issueIds?: string[];

  /** Restrict to one team. A team outside the resolved workspace matches nothing. */
  @IsOptional()
  @IsString()
  teamId?: string;

  /**
   * Optional. Honoured only if the caller is an active member of it, otherwise
   * the request is rejected. Falls back to the session's workspace when absent.
   */
  @IsOptional()
  @IsString()
  workspaceId?: string;
}

export class GetIssuesByFilterDTO {
  @IsObject()
  filters: {
    [K in FilterKey]?: FilterValue;
  };

  /**
   * Optional. Honoured only if the caller is an active member of it, otherwise
   * the request is rejected. Falls back to the session's workspace when absent.
   *
   * A user can belong to several workspaces, so the client names the one it
   * wants — but this value used to be trusted outright, which let any
   * authenticated caller read another workspace's issues.
   */
  @IsOptional()
  @IsString()
  workspaceId?: string;

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

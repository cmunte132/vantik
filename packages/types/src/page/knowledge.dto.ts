import { Transform } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  NotEquals,
} from 'class-validator';

import { parseIdList } from './create-page-entry.dto';
import { PageEntryKindEnum } from './page.entity';

const toList = ({ value }: { value: unknown }) =>
  value === undefined || value === null ? value : parseIdList(value);

export class KnowledgeGapsQueryDto {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;
}

export class KnowledgeLooseQueryDto {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  /**
   * A page. If the request has a page, the response holds only the groups
   * of loose facts that the gardener suggests to move under that page.
   */
  @IsOptional()
  @IsUUID()
  pageId?: string;
}

export class KnowledgeSearchQueryDto {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  /**
   * The query must name a question. A wildcard cannot select the whole
   * workspace through this endpoint.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @NotEquals('*')
  query: string;

  /** Restrict to facts asserted about this repo path, team or project. */
  @IsOptional()
  @IsString()
  scope?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  limit?: string;

  /** Only these kinds of entry. Page bodies are not entries and drop out. */
  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsEnum(PageEntryKindEnum, { each: true })
  kind?: PageEntryKindEnum[];

  /** Rank knowledge about these modules, and their neighbours, first. */
  @IsOptional()
  @Transform(toList)
  @IsArray()
  @IsUUID(undefined, { each: true })
  moduleIds?: string[];

  /** Rank knowledge about this issue's modules and capability first. */
  @IsOptional()
  @IsUUID()
  issueId?: string;
}

export class KnowledgeContextDto {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  /**
   * What the caller is about to work on. Free text is fine — an agent starting
   * a task can describe it, which is more than it can do for a search query.
   */
  @IsOptional()
  @IsString()
  query?: string;

  @IsOptional()
  @IsString()
  scope?: string;

  /**
   * How much context the caller can afford. Required in spirit: without it this
   * is an unbounded dump that gets worse as the bank grows, which is exactly
   * how file-based memory fails today.
   */
  @IsOptional()
  @IsNumber()
  tokenBudget?: number;

  /**
   * The modules the work is in. Knowledge about them, and about their
   * neighbours in the product graph, is ranked first.
   */
  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  moduleIds?: string[];

  /** The issue the work is for; its modules and capability seed the ranking. */
  @IsOptional()
  @IsUUID()
  issueId?: string;
}

export class KnowledgeSimilarDto {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  /**
   * The page that the fact goes on. If the request has no page, the fact is
   * loose, and the server looks for near matches in the whole workspace.
   */
  @IsOptional()
  @IsUUID()
  pageId?: string;

  /** The fact about to be written, so near matches can be shown to the caller. */
  @IsString()
  content: string;
}

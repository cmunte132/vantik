import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  NotEquals,
} from 'class-validator';

export class KnowledgeGapsQueryDto {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;
}

export class KnowledgeSearchQueryDto {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  /**
   * Required. A wildcard is not a question: typesense skips both the keyword
   * match and the query embedding for `*`, and returns the whole workspace
   * unranked — which is the unbounded dump the budget exists to prevent.
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
}

export class KnowledgeSimilarDto {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @IsUUID()
  pageId: string;

  /** The fact about to be written, so near matches can be shown to the caller. */
  @IsString()
  content: string;
}

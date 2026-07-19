import { IsOptional, IsString } from 'class-validator';

export class SearchInputData {
  @IsString()
  query: string;

  @IsString()
  workspaceId: string;

  @IsOptional()
  @IsString()
  limit?: string;

  @IsOptional()
  @IsString()
  threshold?: string;

  /**
   * Comma-separated workflow categories (TRIAGE, BACKLOG, UNSTARTED, STARTED,
   * COMPLETED, CANCELED). Lets a caller search only resolved work.
   */
  @IsOptional()
  @IsString()
  stateCategory?: string;
}

export class SimilarIssueData {
  @IsString()
  workspaceId: string;

  @IsString()
  issueId: string;

  @IsOptional()
  @IsString()
  limit?: string;
}

export function parseStateCategories(stateCategory?: string): string[] {
  if (!stateCategory) {
    return [];
  }

  return stateCategory
    .split(',')
    .map((category) => category.trim().toUpperCase())
    .filter(Boolean);
}

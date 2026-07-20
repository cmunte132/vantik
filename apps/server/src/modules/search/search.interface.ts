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

export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 100;
export const DEFAULT_VECTOR_DISTANCE = 0.8;

/**
 * Query params arrive as strings and every numeric one here is optional.
 * `parseInt(undefined)` is NaN, and a NaN carried into the typesense query
 * fails the whole request — so omitting `limit` used to turn a valid search
 * into a 500. A default on the service signature does not help: the controller
 * passes NaN explicitly, and defaults only apply to `undefined`.
 */
function parseNumberParam(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseSearchLimit(limit?: string): number {
  const parsed = parseNumberParam(limit, DEFAULT_SEARCH_LIMIT);
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_SEARCH_LIMIT);
}

export function parseVectorDistance(threshold?: string): number {
  const parsed = parseNumberParam(threshold, DEFAULT_VECTOR_DISTANCE);
  // Cosine distance; anything outside 0..2 matches everything or nothing.
  return Math.min(Math.max(parsed, 0), 2);
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

import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * `workspaceId` is optional and checked against the caller's memberships. It
 * used to be trusted, which let any authenticated caller search any workspace —
 * and search hits carry title, description and comment text.
 */
export class SearchInputData {
  @IsString()
  @IsNotEmpty()
  query: string;

  @IsOptional()
  @IsString()
  workspaceId?: string;

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

  /**
   * Comma-separated module ids. A hit matches when the issue names any one of
   * them, because an issue records the modules it changes as a list.
   */
  @IsOptional()
  @IsString()
  moduleIds?: string;

  /** One capability id. An issue delivers one capability, or none. */
  @IsOptional()
  @IsString()
  capabilityId?: string;
}

export class SimilarIssueData {
  @IsString()
  issueId: string;

  @IsOptional()
  @IsString()
  workspaceId?: string;

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

/**
 * This function reads a comma-separated list of ids.
 *
 * A query string carries one value, so a caller asking for several modules
 * sends them joined. An empty entry is dropped, so a trailing comma is not an
 * id that matches nothing.
 */
export function parseIds(ids?: string): string[] {
  if (!ids) {
    return [];
  }

  return ids
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

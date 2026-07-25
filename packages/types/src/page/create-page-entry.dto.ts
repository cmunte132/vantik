import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

import { PageEntryStatusEnum } from './page.entity';

/**
 * Accepts `?status=STANDING`, `?status=STANDING,PROPOSED` and repeated
 * `?status=` params alike.
 *
 * A query string has no way to say "array of one", so a bare `status=STANDING`
 * arrives as a string and fails an `@IsArray()` check — which is a 400 on the
 * most obvious way to call the endpoint, and the shape agent-core sends.
 */
export function parseEntryStatuses(
  value: unknown,
): PageEntryStatusEnum[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const values = Array.isArray(value)
    ? value
    : String(value)
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);

  return values as PageEntryStatusEnum[];
}

const toStatusArray = ({ value }: { value: unknown }) =>
  value === undefined || value === null ? value : parseEntryStatuses(value);

export class CreatePageEntryDto {
  /** Markdown, short. One self-contained claim. */
  @IsString()
  content: string;

  /** Repo path glob, team or project the claim applies to. */
  @IsOptional()
  @IsString()
  scope?: string;

  /** Opaque harness session id, so the claim can be traced back to a run. */
  @IsOptional()
  @IsString()
  sourceSession?: string;

  /**
   * The entry this one replaces. Supplying it flips the older row to
   * SUPERSEDED in the same transaction, so a correction never leaves two
   * truths sitting side by side.
   */
  @IsOptional()
  @IsUUID()
  supersedesId?: string;

  /**
   * Land the entry as STANDING rather than PROPOSED. Only a human reviewer may
   * ask for this; an agent's writes always start in the inbox.
   */
  @IsOptional()
  @IsBoolean()
  standing?: boolean;
}

export class UpdatePageEntryDto {
  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsString()
  scope?: string;

  /**
   * Triage. Only the transitions the service allows are accepted — CONSOLIDATED
   * and SUPERSEDED are terminal, and nothing may be set back to PROPOSED.
   */
  @IsOptional()
  @IsEnum(PageEntryStatusEnum)
  status?: PageEntryStatusEnum;

  @IsOptional()
  @IsBoolean()
  verified?: boolean;
}

export class PageEntryRequestParamsDto {
  @IsUUID()
  pageEntryId: string;
}

export class ListPageEntriesQueryDto {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @IsOptional()
  @IsUUID()
  pageId?: string;

  @IsOptional()
  @Transform(toStatusArray)
  @IsArray()
  @IsEnum(PageEntryStatusEnum, { each: true })
  status?: PageEntryStatusEnum[];
}

/**
 * Bulk triage. The review rail acts on facets — "24 from claude-opus-5 scoped
 * apps/server/prisma" — so the API has to take a set of ids and one decision,
 * or a reviewer is back to thirty-eight individual round trips.
 */
export class BulkUpdatePageEntriesDto {
  @IsArray()
  @IsUUID(undefined, { each: true })
  entryIds: string[];

  @IsEnum(PageEntryStatusEnum)
  status: PageEntryStatusEnum;
}

/** Folds standing entries into the page body and marks them CONSOLIDATED. */
export class ConsolidatePageDto {
  /** Entries to fold. Omit to fold every standing entry on the page. */
  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  entryIds?: string[];

  /**
   * The rewritten page body, in markdown. The caller is the one that decided
   * how the facts read as prose, so the server does not attempt to write it.
   */
  @IsString()
  descriptionMarkdown: string;
}

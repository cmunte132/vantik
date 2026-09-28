import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

import {
  PageEntryPolicyEnum,
  PageKindEnum,
  PageLinkTypeEnum,
} from './page.entity';

export class CreatePageDto {
  @IsString()
  title: string;

  /**
   * Markdown. Converted to tiptap JSON server-side, so no caller has to hold
   * the editor's format.
   */
  @IsOptional()
  @IsString()
  descriptionMarkdown?: string;

  /**
   * Tiptap JSON, for the webapp — its editor already holds that format, and
   * round-tripping it through markdown to satisfy the API would lose whatever
   * markdown cannot express. Every other caller should send
   * `descriptionMarkdown` and never see this field.
   */
  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;

  @IsOptional()
  @IsNumber()
  sortOrder?: number;

  @IsOptional()
  @IsEnum(PageEntryPolicyEnum)
  entryPolicy?: PageEntryPolicyEnum;

  /**
   * GENERATED for a page the gardener builds from the knowledge in its scope,
   * which then needs a `question`. AUTHORED, the default, otherwise.
   */
  @IsOptional()
  @IsEnum(PageKindEnum)
  kind?: PageKindEnum;

  /** The question a generated page answers. */
  @IsOptional()
  @IsString()
  question?: string;
}

export class UpdatePageDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  descriptionMarkdown?: string;

  /** Tiptap JSON. See CreatePageDto.description. */
  @IsOptional()
  @IsString()
  description?: string;

  /**
   * Reparent. `null` moves the page to the root; a page cannot be made its own
   * ancestor, which the service checks rather than the validator.
   */
  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @IsOptional()
  @IsNumber()
  sortOrder?: number;

  @IsOptional()
  @IsEnum(PageEntryPolicyEnum)
  entryPolicy?: PageEntryPolicyEnum;

  /**
   * AUTHORED takes a generated page over by hand: the gardener stops
   * building it, and its body is edited like any other. A page people wrote
   * is never handed to the gardener, which would rewrite it whole; a
   * generated page is made as one.
   */
  @IsOptional()
  @IsEnum(PageKindEnum)
  kind?: PageKindEnum;

  /** A generated page's question. Changing it rebuilds the page. */
  @IsOptional()
  @IsString()
  question?: string;
}

export class PageRequestParamsDto {
  @IsUUID()
  pageId: string;
}

/** Accepting or declining a proposed change to a page body. */
export class PageProposalParamsDto {
  @IsUUID()
  pageId: string;

  @IsUUID()
  proposalId: string;
}

/** Undoing one recorded change to a page body. */
export class PageRevertParamsDto {
  @IsUUID()
  pageId: string;

  @IsUUID()
  historyId: string;
}

/** One edge from a page to a team, project, issue or other page. */
export class CreatePageLinkDto {
  @IsEnum(PageLinkTypeEnum)
  entityType: PageLinkTypeEnum;

  @IsUUID()
  entityId: string;
}

export class PageLinkRequestParamsDto {
  @IsUUID()
  pageId: string;

  @IsUUID()
  linkId: string;
}

/** The reverse lookup: which pages relate to one thing. */
export class RelatedPagesQueryDto {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  @IsEnum(PageLinkTypeEnum)
  entityType: PageLinkTypeEnum;

  @IsUUID()
  entityId: string;
}

export class ListPagesQueryDto {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  /** Only the children of this page. Omit for the whole tree. */
  @IsOptional()
  @IsUUID()
  parentId?: string;

  /**
   * `true` to leave the bodies out: every page in the workspace comes back with
   * its title, its place in the tree and its policy, and `description` null.
   *
   * The list is what a caller reads to turn a title into an id, and a full
   * response converts every body in the bank from tiptap JSON to markdown to
   * answer that. Sent as a string because query params are strings and the
   * global ValidationPipe does not transform.
   */
  @IsOptional()
  @IsString()
  summary?: string;
}

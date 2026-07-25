import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

import { PageEntryPolicyEnum } from './page.entity';

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
}

export class PageRequestParamsDto {
  @IsUUID()
  pageId: string;
}

export class ListPagesQueryDto {
  @IsOptional()
  @IsUUID()
  workspaceId?: string;

  /** Only the children of this page. Omit for the whole tree. */
  @IsOptional()
  @IsUUID()
  parentId?: string;
}

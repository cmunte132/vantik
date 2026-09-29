import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  BulkUpdatePageEntriesDto,
  CreatePageEntryDto,
  CreatePageEntryQueryDto,
  ListPageEntriesQueryDto,
  MovePageEntriesDto,
  PageEntry,
  PageEntryRequestParamsDto,
  UpdatePageEntryDto,
  parseEntryStatuses,
  parseIdList,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { resolveWorkspaceId } from 'common/workspace-access';

import { AuthGuard } from 'modules/auth/auth.guard';
import { TokenId, UserId, Workspace } from 'modules/auth/session.decorator';
import { WorkspaceResourceGuard } from 'modules/auth/workspace-resource.guard';

import { parseKnowledgeLimit } from './knowledge.controller';
import PageEntriesService from './page-entries.service';

@Controller({
  version: '1',
  path: 'page_entries',
})
export class PageEntriesController {
  constructor(
    private pageEntriesService: PageEntriesService,
    private prisma: PrismaService,
  ) {}

  @Get()
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async getEntries(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Query() query: ListPageEntriesQueryDto,
  ): Promise<PageEntry[]> {
    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      query.workspaceId,
    );

    return this.pageEntriesService.getEntries(workspaceId, {
      pageId: query.pageId,
      loose: query.loose,
      // A query string has no way to say "array of one", so `?status=STANDING`
      // reaches the handler as a bare string however the DTO validated it —
      // and a string would reach Prisma as `status: { in: 'STANDING' }`.
      status: parseEntryStatuses(query.status),
      // The same caveat: `?moduleIds=a` arrives as a string whatever the DTO
      // made of it, so it is split here too.
      moduleIds: parseIdList(query.moduleIds),
      ids: parseIdList(query.ids),
      limit: parseKnowledgeLimit(query.limit),
    });
  }

  /**
   * With `pageId`, the guard reads the page out of the query and proves it
   * belongs to the caller's workspace. Without it, the fact is loose, and it
   * goes into the workspace of the caller's session or token, resolved the
   * same way as every workspace-wide route. It is never taken from a page,
   * so a request that names no page cannot land in another workspace.
   */
  @Post()
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async createEntry(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @TokenId() tokenId: string | null,
    @Query() query: CreatePageEntryQueryDto,
    @Body() entryData: CreatePageEntryDto,
  ): Promise<PageEntry> {
    if (query.pageId) {
      return this.pageEntriesService.createEntry(
        query.pageId,
        { userId, tokenId },
        entryData,
      );
    }

    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      query.workspaceId,
    );

    return this.pageEntriesService.createEntry(
      null,
      { userId, tokenId },
      entryData,
      workspaceId,
    );
  }

  @Post('bulk')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async bulkUpdate(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Query() query: ListPageEntriesQueryDto,
    @Body() input: BulkUpdatePageEntriesDto,
  ): Promise<{ updated: number; skipped: number }> {
    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      query.workspaceId,
    );

    return this.pageEntriesService.bulkUpdate(workspaceId, userId, input);
  }

  /** Files facts under a page, and records each move on the fact's trail. */
  @Post('move')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async moveEntries(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Query() query: ListPageEntriesQueryDto,
    @Body() input: MovePageEntriesDto,
  ): Promise<{ moved: string[]; skipped: number }> {
    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      query.workspaceId,
    );

    return this.pageEntriesService.moveEntries(workspaceId, userId, input);
  }

  @Post(':pageEntryId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async updateEntry(
    @UserId() userId: string,
    @Param() params: PageEntryRequestParamsDto,
    @Body() entryData: UpdatePageEntryDto,
  ): Promise<PageEntry> {
    return this.pageEntriesService.updateEntry(
      params.pageEntryId,
      userId,
      entryData,
    );
  }
}

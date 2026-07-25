import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  BulkUpdatePageEntriesDto,
  CreatePageEntryDto,
  ListPageEntriesQueryDto,
  PageEntry,
  PageEntryRequestParamsDto,
  UpdatePageEntryDto,
  parseEntryStatuses,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { resolveWorkspaceId } from 'common/workspace-access';

import { AuthGuard } from 'modules/auth/auth.guard';
import { TokenId, UserId, Workspace } from 'modules/auth/session.decorator';
import { WorkspaceResourceGuard } from 'modules/auth/workspace-resource.guard';

import PageEntriesService, { EntryFacets } from './page-entries.service';

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
      // A query string has no way to say "array of one", so `?status=STANDING`
      // reaches the handler as a bare string however the DTO validated it —
      // and a string would reach Prisma as `status: { in: 'STANDING' }`.
      status: parseEntryStatuses(query.status),
    });
  }

  /**
   * Counts by source, scope and status. The review rail opens on these rather
   * than on rows, so a reviewer makes four decisions instead of thirty-eight.
   */
  @Get('facets')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async getFacets(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Query() query: ListPageEntriesQueryDto,
  ): Promise<EntryFacets> {
    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      query.workspaceId,
    );

    return this.pageEntriesService.getFacets(workspaceId, query.pageId);
  }

  @Post()
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async createEntry(
    @UserId() userId: string,
    @TokenId() tokenId: string | null,
    @Query() query: ListPageEntriesQueryDto,
    @Body() entryData: CreatePageEntryDto,
  ): Promise<PageEntry> {
    return this.pageEntriesService.createEntry(
      query.pageId,
      { userId, tokenId },
      entryData,
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

    return this.pageEntriesService.bulkUpdate(workspaceId, input);
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

  @Delete(':pageEntryId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async deleteEntry(
    @Param() params: PageEntryRequestParamsDto,
  ): Promise<PageEntry> {
    return this.pageEntriesService.deleteEntry(params.pageEntryId);
  }
}

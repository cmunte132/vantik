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
  ConsolidatePageDto,
  CreatePageDto,
  ListPagesQueryDto,
  PageRequestParamsDto,
  PageRevertParamsDto,
  UpdatePageDto,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { resolveWorkspaceId } from 'common/workspace-access';

import { AuthGuard } from 'modules/auth/auth.guard';
import { UserId, Workspace } from 'modules/auth/session.decorator';
import { WorkspaceResourceGuard } from 'modules/auth/workspace-resource.guard';

import PagesService, { PageResponse, PageRevision } from './pages.service';

@Controller({
  version: '1',
  path: 'pages',
})
export class PagesController {
  constructor(
    private pagesService: PagesService,
    private prisma: PrismaService,
  ) {}

  @Get()
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async getPages(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Query() query: ListPagesQueryDto,
  ): Promise<PageResponse[]> {
    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      query.workspaceId,
    );

    return this.pagesService.getPages(workspaceId, query.parentId);
  }

  @Get(':pageId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async getPage(
    @Param() params: PageRequestParamsDto,
  ): Promise<PageResponse & { ancestors: Array<{ id: string; title: string }> }> {
    const [page, ancestors] = await Promise.all([
      this.pagesService.getPage(params.pageId),
      this.pagesService.getAncestors(params.pageId),
    ]);

    return { ...page, ancestors };
  }

  @Get(':pageId/backlinks')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async getBacklinks(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Param() params: PageRequestParamsDto,
    @Query() query: ListPagesQueryDto,
  ) {
    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      query.workspaceId,
    );

    return this.pagesService.getBacklinks(params.pageId, workspaceId);
  }

  /**
   * What has happened to this page, and what it said before each change.
   *
   * Agents may rewrite a body wholesale to keep it current. That is the point
   * of letting them edit at all, and it is only safe if the change can be seen
   * afterwards and undone.
   */
  @Get(':pageId/history')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async getHistory(
    @Param() params: PageRequestParamsDto,
  ): Promise<PageRevision[]> {
    return this.pagesService.getHistory(params.pageId);
  }

  @Post()
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async createPage(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Query() query: ListPagesQueryDto,
    @Body() pageData: CreatePageDto,
  ): Promise<PageResponse> {
    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      query.workspaceId,
    );

    return this.pagesService.createPage(workspaceId, userId, pageData);
  }

  @Post(':pageId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async updatePage(
    @UserId() userId: string,
    @Param() params: PageRequestParamsDto,
    @Body() pageData: UpdatePageDto,
  ): Promise<PageResponse> {
    return this.pagesService.updatePage(params.pageId, userId, pageData);
  }

  @Post(':pageId/consolidate')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async consolidatePage(
    @UserId() userId: string,
    @Param() params: PageRequestParamsDto,
    @Body() input: ConsolidatePageDto,
  ): Promise<PageResponse> {
    return this.pagesService.consolidate(params.pageId, userId, input);
  }

  @Post(':pageId/revert/:historyId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async revertBody(
    @UserId() userId: string,
    @Param() params: PageRevertParamsDto,
  ): Promise<PageResponse> {
    return this.pagesService.revertBody(
      params.pageId,
      params.historyId,
      userId,
    );
  }

  @Delete(':pageId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async deletePage(
    @UserId() userId: string,
    @Param() params: PageRequestParamsDto,
  ): Promise<PageResponse> {
    return this.pagesService.deletePage(params.pageId, userId);
  }
}

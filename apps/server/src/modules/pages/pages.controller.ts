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
  CreatePageLinkDto,
  ListPagesQueryDto,
  PageLinkRequestParamsDto,
  PageRequestParamsDto,
  PageRevertParamsDto,
  RelatedPagesQueryDto,
  UpdatePageDto,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { resolveWorkspaceId } from 'common/workspace-access';

import { AuthGuard } from 'modules/auth/auth.guard';
import { UserId, Workspace } from 'modules/auth/session.decorator';
import { WorkspaceResourceGuard } from 'modules/auth/workspace-resource.guard';

import PageLinksService, {
  type RelatedPage,
  type ResolvedLink,
} from './page-links.service';
import PagesService, { PageResponse, PageRevision } from './pages.service';

@Controller({
  version: '1',
  path: 'pages',
})
export class PagesController {
  constructor(
    private pagesService: PagesService,
    private pageLinksService: PageLinksService,
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

  /**
   * Which pages relate to one team, project or issue.
   *
   * The whole point of the graph: an agent handed an issue can reach its
   * documentation without knowing what the documentation is called.
   *
   * Declared above `:pageId` on purpose — Nest matches in declaration order,
   * so a literal segment placed after a parameter is never reached.
   */
  @Get('related')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async getRelatedPages(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Query() query: RelatedPagesQueryDto,
  ): Promise<RelatedPage[]> {
    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      query.workspaceId,
    );

    return this.pageLinksService.getRelatedPages(
      query.entityType,
      query.entityId,
      workspaceId,
    );
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
   * What this page is linked to.
   *
   * Separate from `backlinks`, which is a scan for pages *mentioned* in issue
   * prose. A mention is something somebody happened to write; a link is
   * something somebody asserted, and only the second is worth traversing in
   * both directions.
   */
  @Get(':pageId/links')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async getLinks(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Param() params: PageRequestParamsDto,
    @Query() query: ListPagesQueryDto,
  ): Promise<ResolvedLink[]> {
    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      query.workspaceId,
    );

    return this.pageLinksService.getLinks(params.pageId, workspaceId);
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

  @Post(':pageId/links')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async createLink(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Param() params: PageRequestParamsDto,
    @Query() query: ListPagesQueryDto,
    @Body() input: CreatePageLinkDto,
  ): Promise<ResolvedLink> {
    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      query.workspaceId,
    );

    return this.pageLinksService.createLink(
      params.pageId,
      workspaceId,
      userId,
      input,
    );
  }

  @Delete(':pageId/links/:linkId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async deleteLink(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Param() params: PageLinkRequestParamsDto,
    @Query() query: ListPagesQueryDto,
  ): Promise<{ id: string }> {
    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      query.workspaceId,
    );

    return this.pageLinksService.deleteLink(
      params.pageId,
      params.linkId,
      workspaceId,
    );
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

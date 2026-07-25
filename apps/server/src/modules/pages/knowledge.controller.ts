import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import {
  KnowledgeContextDto,
  KnowledgeGapsQueryDto,
  KnowledgeSearchQueryDto,
  KnowledgeSimilarDto,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { resolveWorkspaceId } from 'common/workspace-access';

import { AuthGuard } from 'modules/auth/auth.guard';
import { UserId, Workspace } from 'modules/auth/session.decorator';
import { WorkspaceResourceGuard } from 'modules/auth/workspace-resource.guard';
import {
  KnowledgeSearchHit,
  KnowledgeSearchResult,
} from 'modules/vector/vector.interface';

import KnowledgeService, {
  ContextPack,
  KnowledgeGap,
} from './knowledge.service';

/**
 * Reading the knowledge bank.
 *
 * Neutral, like every other REST surface here: it exposes the mechanism and
 * holds no view on what a caller ought to look up. The curation opinion lives
 * in the MCP tool layer alone.
 */
@Controller({
  version: '1',
  path: 'knowledge',
})
export class KnowledgeController {
  constructor(
    private knowledgeService: KnowledgeService,
    private prisma: PrismaService,
  ) {}

  @Get('search')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async search(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Query() query: KnowledgeSearchQueryDto,
  ): Promise<KnowledgeSearchResult> {
    const workspaceId = await this.workspace(
      userId,
      sessionWorkspaceId,
      query.workspaceId,
    );
    const limit = parseKnowledgeLimit(query.limit);

    return this.knowledgeService.search(workspaceId, query.query, {
      limit,
      scope: query.scope,
    });
  }

  @Post('context')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async contextPack(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Body() input: KnowledgeContextDto,
  ): Promise<ContextPack> {
    const workspaceId = await this.workspace(
      userId,
      sessionWorkspaceId,
      input.workspaceId,
    );

    return this.knowledgeService.contextPack(workspaceId, input);
  }

  @Get('similar')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async similar(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Query() query: KnowledgeSimilarDto,
  ): Promise<KnowledgeSearchHit[]> {
    const workspaceId = await this.workspace(
      userId,
      sessionWorkspaceId,
      query.workspaceId,
    );

    return this.knowledgeService.similarEntries(
      workspaceId,
      query.pageId,
      query.content,
    );
  }

  @Get('gaps')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async gaps(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Query() query: KnowledgeGapsQueryDto,
  ): Promise<KnowledgeGap[]> {
    const workspaceId = await this.workspace(
      userId,
      sessionWorkspaceId,
      query.workspaceId,
    );

    return this.knowledgeService.knowledgeGaps(workspaceId);
  }

  private workspace(
    userId: string,
    sessionWorkspaceId: string,
    requested?: string,
  ): Promise<string> {
    return resolveWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      requested,
    );
  }
}

export function parseKnowledgeLimit(limit?: string): number | undefined {
  if (!limit) {
    return undefined;
  }

  const parsed = Number(limit);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

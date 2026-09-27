import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  KnowledgeContextDto,
  KnowledgeGapsQueryDto,
  KnowledgeSearchQueryDto,
  KnowledgeSimilarDto,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { resolveWorkspaceId } from 'common/workspace-access';

import { RequiresScope } from 'modules/auth/agent-scope';
import { AuthGuard } from 'modules/auth/auth.guard';
import { TokenId, UserId, Workspace } from 'modules/auth/session.decorator';
import { WorkspaceResourceGuard } from 'modules/auth/workspace-resource.guard';
import {
  KnowledgeSearchHit,
  KnowledgeSearchResult,
} from 'modules/vector/vector.interface';

import KnowledgeService, {
  ContextPack,
  KnowledgeGap,
  type KnowledgeReader,
} from './knowledge.service';
import { HARNESS_SESSION_HEADER, harnessSessionOf } from './pages.interface';

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
    @TokenId() tokenId: string | null,
    @Headers(HARNESS_SESSION_HEADER) session: string | undefined,
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
      kinds: query.kind,
      moduleIds: query.moduleIds,
      issueId: query.issueId,
      reader: reader(userId, tokenId, session),
    });
  }

  /**
   * A read that arrives as a POST because it carries a body. Declared, or the
   * method reads as a write and a read-only agent — the one most likely to be
   * sent to look something up first — is locked out of `load_context`.
   */
  @Post('context')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  @RequiresScope('read')
  async contextPack(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @TokenId() tokenId: string | null,
    @Headers(HARNESS_SESSION_HEADER) session: string | undefined,
    @Body() input: KnowledgeContextDto,
  ): Promise<ContextPack> {
    const workspaceId = await this.workspace(
      userId,
      sessionWorkspaceId,
      input.workspaceId,
    );

    return this.knowledgeService.contextPack(workspaceId, {
      ...input,
      reader: reader(userId, tokenId, session),
    });
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

/** Who a request came from, for the uses it records. */
function reader(
  userId: string,
  tokenId: string | null,
  session: string | undefined,
): KnowledgeReader {
  return { userId, tokenId, sessionId: harnessSessionOf(session) };
}

import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  type KnowledgeBackoffRecord,
  type KnowledgeGardener,
  KnowledgeGapsQueryDto,
  type KnowledgeMaintenanceRecord,
  type KnowledgeMap,
  KnowledgeMapQueryDto,
  KnowledgeRecordsQueryDto,
  type KnowledgeRelationRecord,
  type KnowledgeRunTrace,
  type KnowledgeSignalRecord,
  type KnowledgeTracedRun,
  type KnowledgeUseRecord,
  RoleEnum,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { resolveWorkspaceId } from 'common/workspace-access';

import { AuthGuard } from 'modules/auth/auth.guard';
import { Role, UserId, Workspace } from 'modules/auth/session.decorator';
import { WorkspaceResourceGuard } from 'modules/auth/workspace-resource.guard';

import KnowledgeGardenerService from './knowledge-gardener.service';
import KnowledgeRecordsService from './knowledge-records.service';

/**
 * These routes show people what the gardener does: the records it keeps
 * about entries, the gardener view, the map of what the workspace knows, and
 * the trace of the pack that each run got.
 *
 * All of it is for people, for the reason that review is. An agent can read
 * every entry through the knowledge routes. The records here tell how
 * triage and the packs choose, and so how to write an entry that gets past
 * them.
 */
@Controller({
  version: '1',
  path: 'knowledge',
})
export class KnowledgeGardenerController {
  constructor(
    private records: KnowledgeRecordsService,
    private gardener: KnowledgeGardenerService,
    private prisma: PrismaService,
  ) {}

  /** How entries relate: contradictions, refinements and replacements. */
  @Get('relations')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async relations(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Role() role: string,
    @Query() query: KnowledgeRecordsQueryDto,
  ): Promise<KnowledgeRelationRecord[]> {
    return this.records.relations(
      await this.workspace(role, userId, sessionWorkspaceId, query.workspaceId),
      query,
    );
  }

  /** Who got each entry, and by which route. */
  @Get('uses')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async uses(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Role() role: string,
    @Query() query: KnowledgeRecordsQueryDto,
  ): Promise<KnowledgeUseRecord[]> {
    return this.records.uses(
      await this.workspace(role, userId, sessionWorkspaceId, query.workspaceId),
      query,
    );
  }

  /** What runs and their pull requests said about the entries they got. */
  @Get('signals')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async signals(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Role() role: string,
    @Query() query: KnowledgeRecordsQueryDto,
  ): Promise<KnowledgeSignalRecord[]> {
    return this.records.signals(
      await this.workspace(role, userId, sessionWorkspaceId, query.workspaceId),
      query,
    );
  }

  /** What the gardener did to entries, or asked a person to do. */
  @Get('maintenance')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async maintenance(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Role() role: string,
    @Query() query: KnowledgeRecordsQueryDto,
  ): Promise<KnowledgeMaintenanceRecord[]> {
    return this.records.maintenance(
      await this.workspace(role, userId, sessionWorkspaceId, query.workspaceId),
      query,
    );
  }

  /** When each decision type stopped or started again to act alone. */
  @Get('backoff')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async backoff(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Role() role: string,
    @Query() query: KnowledgeRecordsQueryDto,
  ): Promise<KnowledgeBackoffRecord[]> {
    return this.records.backoff(
      await this.workspace(role, userId, sessionWorkspaceId, query.workspaceId),
      query,
    );
  }

  @Get('gardener')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async view(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Role() role: string,
    @Query() query: KnowledgeGapsQueryDto,
  ): Promise<KnowledgeGardener> {
    return this.gardener.gardener(
      await this.workspace(role, userId, sessionWorkspaceId, query.workspaceId),
    );
  }

  /** The graph of what the workspace knows, at the end of `asOf`. */
  @Get('map')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async map(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Role() role: string,
    @Query() query: KnowledgeMapQueryDto,
  ): Promise<KnowledgeMap> {
    return this.gardener.map(
      await this.workspace(role, userId, sessionWorkspaceId, query.workspaceId),
      query.asOf,
    );
  }

  /** The runs whose packs can be traced, for the picker. */
  @Get('traces')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async traces(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Role() role: string,
    @Query() query: KnowledgeGapsQueryDto,
  ): Promise<KnowledgeTracedRun[]> {
    return this.gardener.tracedRuns(
      await this.workspace(role, userId, sessionWorkspaceId, query.workspaceId),
    );
  }

  @Get('traces/:runId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async trace(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Role() role: string,
    @Param('runId') runId: string,
    @Query() query: KnowledgeGapsQueryDto,
  ): Promise<KnowledgeRunTrace> {
    return this.gardener.trace(
      await this.workspace(role, userId, sessionWorkspaceId, query.workspaceId),
      runId,
    );
  }

  private async workspace(
    role: string,
    userId: string,
    sessionWorkspaceId: string,
    requested?: string,
  ): Promise<string> {
    if (role === RoleEnum.AGENT) {
      throw new ForbiddenException({
        message:
          'What the gardener does is for people. The knowledge routes serve ' +
          'agents every entry they need.',
      });
    }

    return resolveWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      requested,
    );
  }
}

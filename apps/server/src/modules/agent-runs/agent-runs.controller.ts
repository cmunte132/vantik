import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  AgentRunFilterDto,
  AgentRunRequestParamsDto,
  AppendAgentRunEventDto,
  CancelAgentRunDto,
  ClaimAgentRunDto,
  CreateAgentRunDto,
  ReportAgentRunDto,
  RoleEnum,
  StartAgentRunDto,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { AuthGuard } from 'modules/auth/auth.guard';
import { RequiresScope } from 'modules/auth/agent-scope';
import { Role, UserId, Workspace } from 'modules/auth/session.decorator';
import { WorkspaceResourceGuard } from 'modules/auth/workspace-resource.guard';

import { AgentDelegationService } from './agent-delegation.service';
import { AgentRunsService, type AgentRunScope } from './agent-runs.service';
import { ExecutorRegistry } from './executors/executor.registry';

/**
 * The run lifecycle over HTTP.
 *
 * Reads narrow for the principal: a person sees the workspace's runs, an AGENT
 * token sees its own. That is not cosmetic — an agent able to enumerate every
 * run in the workspace can enumerate the workspace's issues through them.
 */
@Controller({
  version: '1',
  path: 'agent_runs',
})
export class AgentRunsController {
  constructor(
    private agentRuns: AgentRunsService,
    private delegation: AgentDelegationService,
    private registry: ExecutorRegistry,
    private prisma: PrismaService,
  ) {}

  @Get()
  @UseGuards(AuthGuard)
  async listRuns(
    @Workspace() workspace: string,
    @UserId() userId: string,
    @Role() role: string,
    @Query() filter: AgentRunFilterDto,
  ) {
    return this.agentRuns.listRuns(filter, this.scope(workspace, userId, role));
  }

  @Get(':agentRunId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async getRun(
    @Workspace() workspace: string,
    @UserId() userId: string,
    @Role() role: string,
    @Param() params: AgentRunRequestParamsDto,
  ) {
    return this.agentRuns.getRun(
      params.agentRunId,
      this.scope(workspace, userId, role),
    );
  }

  @Get(':agentRunId/events')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async listEvents(
    @Workspace() workspace: string,
    @UserId() userId: string,
    @Role() role: string,
    @Param() params: AgentRunRequestParamsDto,
    @Query('since') since?: string,
  ) {
    return this.agentRuns.listEvents(
      params.agentRunId,
      this.scope(workspace, userId, role),
      since ? new Date(since) : undefined,
    );
  }

  /**
   * Opens a run.
   *
   * Delegation authority is an authenticated member action and is never
   * derived from issue content. The threat model for this feature is that the
   * adversary is content the agent reads — the issue body, its comments, the
   * repository — so if anything in that content could start a run, prompt
   * injection would get an execution primitive for free.
   */
  @Post()
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async createRun(
    @Workspace() workspace: string,
    @UserId() userId: string,
    @Body() body: CreateAgentRunDto,
  ) {
    const agentUserId = await this.resolveAgent(workspace, body.agentUserId);

    return this.delegation.delegate({
      issueId: body.issueId,
      workspaceId: workspace,
      agentUserId,
      createdById: userId,
      executor: body.executor,
      config: body.config,
      force: body.force,
    });
  }

  /**
   * A runner asking for work.
   *
   * Long-poll rather than a socket: it survives restarts, works through CI
   * proxies, and keeps the server stateless per request. Returns 204 with no
   * body when there is nothing queued, so an idle runner costs one cheap
   * request per interval.
   *
   * Declared a write because it changes state — it takes ownership of a run.
   */
  @Post('claim')
  @UseGuards(AuthGuard)
  async claimRun(
    @Workspace() workspace: string,
    @UserId() userId: string,
    @Role() role: string,
    @Body() body: ClaimAgentRunDto,
  ) {
    // A person cannot claim work: claiming binds a run to the identity that
    // will be credited with the result, and only an agent has one.
    if (role !== RoleEnum.AGENT) {
      throw new BadRequestException({
        message:
          'Only an agent token can claim runs. Run the daemon with a PAT ' +
          'from an agent account.',
      });
    }

    const run = await this.agentRuns.claimNext({
      workspaceId: workspace,
      agentUserId: userId,
      executor: body.executor,
    });

    return run ?? null;
  }

  /** Renews the lease on a claimed run, and reports if it was stopped. */
  @Post(':agentRunId/heartbeat')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async heartbeat(
    @Workspace() workspace: string,
    @UserId() userId: string,
    @Role() role: string,
    @Param() params: AgentRunRequestParamsDto,
  ) {
    return this.agentRuns.heartbeat(
      params.agentRunId,
      this.scope(workspace, userId, role),
    );
  }

  /** Moves a claimed run to RUNNING once the harness actually starts. */
  @Post(':agentRunId/start')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async startRun(
    @Workspace() workspace: string,
    @UserId() userId: string,
    @Role() role: string,
    @Param() params: AgentRunRequestParamsDto,
    @Body() body: StartAgentRunDto,
  ) {
    return this.agentRuns.transition(
      params.agentRunId,
      'RUNNING',
      {
        startedAt: new Date(),
        ...(body.baseCommit ? { baseCommit: body.baseCommit } : {}),
        ...(body.harnessVersion
          ? { harnessVersion: body.harnessVersion }
          : {}),
        ...(body.modelId ? { modelId: body.modelId } : {}),
      },
      this.scope(workspace, userId, role),
    );
  }

  /** What this deployment can run work on, and whether each is usable here. */
  @Get('meta/executors')
  @UseGuards(AuthGuard)
  async listExecutors(@Workspace() workspace: string) {
    return Promise.all(
      this.registry.list().map(async (executor) => ({
        key: executor.key,
        label: executor.label,
        ...(await executor.availability(workspace)),
      })),
    );
  }

  /**
   * The terminal report from an executor.
   *
   * The server does the linking and the commenting from this; the executor
   * never writes to the issue itself.
   */
  @Post(':agentRunId/report')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async reportRun(
    @Workspace() workspace: string,
    @Param() params: AgentRunRequestParamsDto,
    @Body() body: ReportAgentRunDto,
  ) {
    return this.delegation.report(params.agentRunId, body, workspace);
  }

  @Post(':agentRunId/events')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async appendEvent(
    @Workspace() workspace: string,
    @UserId() userId: string,
    @Role() role: string,
    @Param() params: AgentRunRequestParamsDto,
    @Body() body: AppendAgentRunEventDto,
  ) {
    return this.agentRuns.appendEvent(
      params.agentRunId,
      body,
      this.scope(workspace, userId, role),
    );
  }

  /**
   * A cancel, not a delete.
   *
   * Declared as a write rather than a deletion so an agent granted `write` can
   * stop a run it started. Nothing is destroyed — the record and its log stay
   * exactly as they were, which is the point of asking why it stopped later.
   */
  @Post(':agentRunId/cancel')
  @RequiresScope('write')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async cancelRun(
    @Workspace() workspace: string,
    @UserId() userId: string,
    @Role() role: string,
    @Param() params: AgentRunRequestParamsDto,
    @Body() body: CancelAgentRunDto,
  ) {
    return this.agentRuns.cancelRun(
      params.agentRunId,
      this.scope(workspace, userId, role),
      body.reason,
    );
  }

  @Post(':agentRunId/retry')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async retryRun(
    @Workspace() workspace: string,
    @UserId() userId: string,
    @Role() role: string,
    @Param() params: AgentRunRequestParamsDto,
  ) {
    return this.agentRuns.retryRun(
      params.agentRunId,
      this.scope(workspace, userId, role),
      userId,
    );
  }

  /**
   * An AGENT sees its own runs; anyone else sees the workspace's.
   *
   * Read off the session role rather than looked up, because the role is
   * already in the access token the scope guard validated.
   */
  private scope(
    workspaceId: string,
    userId: string,
    role: string,
  ): AgentRunScope {
    return {
      workspaceId,
      onlyAgentUserId: role === RoleEnum.AGENT ? userId : null,
    };
  }

  /**
   * Which agent to delegate to.
   *
   * Named explicitly, or inferred when the workspace has exactly one agent —
   * making a caller look up a uuid to use the only agent there is would be
   * friction for nothing. Two or more and it has to be said, because picking
   * one for the user would attribute work to an identity they did not choose.
   */
  private async resolveAgent(
    workspaceId: string,
    requested?: string,
  ): Promise<string> {
    const agents = await this.prisma.usersOnWorkspaces.findMany({
      // UsersOnWorkspaces has no soft-delete column; a revoked agent is marked
      // by status rather than removed.
      where: { workspaceId, role: RoleEnum.AGENT, status: 'ACTIVE' },
      select: { userId: true },
    });

    if (requested) {
      if (!agents.some((agent) => agent.userId === requested)) {
        throw new BadRequestException({
          message: `${requested} is not an agent in this workspace.`,
        });
      }
      return requested;
    }

    if (agents.length === 0) {
      throw new BadRequestException({
        message:
          'This workspace has no agent accounts. Create one in Settings → ' +
          'Agents before delegating.',
      });
    }

    if (agents.length > 1) {
      throw new BadRequestException({
        message:
          `This workspace has ${agents.length} agents; name the one to ` +
          'delegate to with agentUserId.',
      });
    }

    return agents[0].userId;
  }
}

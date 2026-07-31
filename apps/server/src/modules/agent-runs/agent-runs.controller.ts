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
  AGENT_RUN_DEFAULT_LIMITS,
  AgentRunFilterDto,
  AgentRunRequestParamsDto,
  AppendAgentRunEventDto,
  CancelAgentRunDto,
  ClaimAgentRunDto,
  CreateAgentRunDto,
  RecordIterationDto,
  ReportAgentRunDto,
  RoleEnum,
  StartAgentRunDto,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { UsersService } from 'modules/users/users.service';

import { AuthGuard } from 'modules/auth/auth.guard';
import { RequiresScope } from 'modules/auth/agent-scope';
import { Role, UserId, Workspace } from 'modules/auth/session.decorator';
import { WorkspaceResourceGuard } from 'modules/auth/workspace-resource.guard';

import { AgentDelegationService } from './agent-delegation.service';
import { AgentRunsService, type AgentRunScope } from './agent-runs.service';
import { ContextPackService } from './context-pack.service';
import { CredentialsService } from './credentials/credentials.service';
import { ExecutorRegistry } from './executors/executor.registry';
import { runIdentityName } from './run-identity';

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
    private credentials: CredentialsService,
    private contextPacks: ContextPackService,
    private users: UsersService,
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
      guidance: body.guidance,
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

  /**
   * The models this workspace's keys can drive.
   *
   * Read by the delegation sheet, so choosing a model is a list rather than a
   * typed string that fails an hour later at run time. Deliberately reachable
   * by any member: delegating is not an administrative act, and the answer
   * carries model ids only — never a hint, a base url, or anything else about
   * the credential the list came from.
   */
  @Get('meta/models')
  @UseGuards(AuthGuard)
  async listModels(@Workspace() workspace: string) {
    const [providers, models] = await Promise.all([
      this.credentials.providers(workspace),
      this.credentials.models(workspace),
    ]);

    // Providers are listed separately rather than derived from the models,
    // because a provider whose catalogue could not be fetched has a working
    // key and no models — and a key you configured vanishing from the picker
    // is worse than a picker with nothing under it.
    return {
      providers: providers.filter(Boolean),
      models,
    };
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
   * What a run against this issue would open, without opening one.
   *
   * The repository, base branch and delivery the delegation sheet states up
   * front. Resolved here because it is the layering of workspace defaults, the
   * issue's modules and the request — none of which the client can see.
   */
  @Get('meta/plan')
  @UseGuards(AuthGuard)
  async plan(
    @Workspace() workspace: string,
    @Query('issueId') issueId: string,
  ) {
    if (!issueId) {
      throw new BadRequestException({
        message: 'Name the issue to plan a run for.',
      });
    }

    const repo = await this.contextPacks.plan(issueId, workspace);

    return {
      repoUrl: repo.repoUrl ?? null,
      repoPath: repo.repoPath ?? null,
      baseBranch: repo.baseBranch ?? null,
      delivery: repo.delivery ?? null,
      limits: AGENT_RUN_DEFAULT_LIMITS,
    };
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

  /**
   * One pass of the ENG-62 loop.
   *
   * Δ is derived server-side from the two pass rates rather than accepted
   * here: it is the reward-hacking metric, and a metric reported by the party
   * being measured is not a metric.
   */
  @Post(':agentRunId/iterations')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async recordIteration(
    @Workspace() workspace: string,
    @UserId() userId: string,
    @Role() role: string,
    @Param() params: AgentRunRequestParamsDto,
    @Body() body: RecordIterationDto,
  ) {
    return this.agentRuns.recordIteration(
      params.agentRunId,
      body,
      this.scope(workspace, userId, role),
    );
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
   * Which identity the work is attributed to.
   *
   * Named explicitly by a caller that has an agent account it wants credited —
   * a BYO runner authenticating as itself, or a script. Otherwise the run gets
   * a fresh identity of its own, created here and managed by nobody.
   *
   * This used to refuse when the workspace had more than one agent, on the
   * reasoning that picking one would attribute work to an identity the user did
   * not choose. That reasoning was right and the conclusion was wrong: the fix
   * is not to make somebody choose, it is to stop making a run borrow an
   * account that belongs to something else. Vantik runs the agent, so Vantik
   * owns the identity — and a workspace that has never provisioned anything can
   * now delegate, which is the point.
   */
  private async resolveAgent(
    workspaceId: string,
    requested?: string,
  ): Promise<string> {
    if (requested) {
      const agent = await this.prisma.usersOnWorkspaces.findFirst({
        // UsersOnWorkspaces has no soft-delete column; a revoked agent is
        // marked by status rather than removed.
        where: {
          workspaceId,
          userId: requested,
          role: RoleEnum.AGENT,
          status: 'ACTIVE',
        },
        select: { userId: true },
      });

      if (!agent) {
        throw new BadRequestException({
          message: `${requested} is not an agent in this workspace.`,
        });
      }

      return agent.userId;
    }

    const minted = await this.users.provisionRunIdentity(
      workspaceId,
      runIdentityName(),
    );

    return minted.id;
  }
}

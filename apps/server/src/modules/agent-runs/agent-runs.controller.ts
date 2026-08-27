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
  CancelAgentRunDto,
  CreateAgentRunDto,
  RoleEnum,
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
 *
 * Nothing here reports *into* a run. An executor runs inside this server and
 * moves the run through `AgentRunsService` directly, so the claim, heartbeat,
 * start, report, event and iteration endpoints that existed for a runner
 * polling from someone else's machine are gone with it. What survives is what
 * a person or an agent asks about a run from outside: read it, start one, stop
 * one, try again.
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

  /**
   * A fresh attempt at the same issue, actually started.
   *
   * Through the delegation service rather than straight to `retryRun`, which
   * creates the row and stops there. That was enough while a backend drained
   * the queue and nothing else does now, so a retry that skipped this returned
   * a run that sat QUEUED for ever — holding a concurrency slot and blocking
   * its issue, while the button that made it looked like it had worked.
   */
  @Post(':agentRunId/retry')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async retryRun(
    @Workspace() workspace: string,
    @UserId() userId: string,
    @Role() role: string,
    @Param() params: AgentRunRequestParamsDto,
  ) {
    return this.delegation.retry(
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
   * Named explicitly by a caller that has an agent account it wants credited,
   * such as a script delegating as itself. Otherwise the run gets a fresh
   * identity of its own, created here and managed by nobody.
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

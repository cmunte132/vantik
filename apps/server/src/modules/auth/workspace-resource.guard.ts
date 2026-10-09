import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import {
  assertAgentQuestionsVisible,
  assertChecklistItemsVisible,
  assertCyclesVisible,
  assertIssueCommentsVisible,
  assertIssuesVisible,
  assertTeamsVisible,
  assertWorkflowsVisible,
  visibleTeamIds,
} from 'common/team-access';
import {
  assertAgentQuestionInWorkspace,
  assertAgentRunInWorkspace,
  assertCapabilityInWorkspace,
  assertChecklistItemInWorkspace,
  assertCycleInWorkspace,
  assertIntegrationAccountInWorkspace,
  assertIssueCommentInWorkspace,
  assertIssueInWorkspace,
  assertLabelInWorkspace,
  assertModuleInWorkspace,
  assertModuleRepoInWorkspace,
  assertPageEntryInWorkspace,
  assertPageInWorkspace,
  assertProductInWorkspace,
  assertProjectInWorkspace,
  assertProjectMilestoneInWorkspace,
  assertTeamInWorkspace,
  assertViewInWorkspace,
  assertWorkflowInWorkspace,
  resolveWorkspaceId,
} from 'common/workspace-access';

import { AuthSessionContext } from 'modules/auth/auth.interface';
import { getAppUserId } from 'modules/auth/session-user';

@Injectable()
export class WorkspaceResourceGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const session = request.session as AuthSessionContext;

    const userId = getAppUserId(session);
    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      session.getAccessTokenPayload().workspaceId,
      request.query?.workspaceId,
    );

    const {
      issueId,
      issueCommentId,
      checklistItemId,
      pageEntryId,
      cycleId,
      projectId,
      productId,
      moduleId,
      moduleRepoId,
      capabilityId,
      agentRunId,
      agentQuestionId,
      labelId,
      viewId,
      workflowId,
      projectMilestoneId,
      integrationAccountId,
      teamId: pathTeamId,
    } = request.params ?? {};

    const bodies = issueBodies(request.body);

    const issueIds = unique([
      issueId,
      request.query?.issueId,
      ...bodies.map((body) => body?.issueId),
    ]);

    const requestTeamIds = unique([
      pathTeamId,
      request.query?.teamId,
      ...bodies.map((body) => body?.teamId),
    ]);

    for (const id of issueIds) {
      await assertIssueInWorkspace(this.prisma, id, workspaceId);
    }

    for (const id of requestTeamIds) {
      await assertTeamInWorkspace(this.prisma, id, workspaceId);
    }

    if (issueCommentId) {
      await assertIssueCommentInWorkspace(
        this.prisma,
        issueCommentId,
        workspaceId,
      );
    }

    const cycleIds = unique([cycleId, ...bodies.map((body) => body?.cycleId)]);

    for (const id of cycleIds) {
      await assertCycleInWorkspace(this.prisma, id, workspaceId);
    }

    if (checklistItemId) {
      await assertChecklistItemInWorkspace(
        this.prisma,
        checklistItemId,
        workspaceId,
      );
    }

    if (agentRunId) {
      await assertAgentRunInWorkspace(this.prisma, agentRunId, workspaceId);
    }

    if (agentQuestionId) {
      await assertAgentQuestionInWorkspace(
        this.prisma,
        agentQuestionId,
        workspaceId,
      );
    }

    const pageIds = unique([request.params?.pageId, request.query?.pageId]);

    for (const id of pageIds) {
      await assertPageInWorkspace(this.prisma, id, workspaceId);
    }

    const entryIds = unique([
      pageEntryId,
      request.body?.supersedesId,
      ...(Array.isArray(request.body?.entryIds) ? request.body.entryIds : []),
    ]);

    for (const id of entryIds) {
      await assertPageEntryInWorkspace(this.prisma, id, workspaceId);
    }

    const productIds = unique([
      productId,
      ...bodies.map((body) => body?.ownerProductId),
      ...bodies.flatMap((body) => list(body?.linkedProductIds)),
    ]);

    for (const id of productIds) {
      await assertProductInWorkspace(this.prisma, id, workspaceId);
    }

    const moduleIds = unique([
      moduleId,
      ...bodies.flatMap((body) => list(body?.moduleIds)),
    ]);

    for (const id of moduleIds) {
      await assertModuleInWorkspace(this.prisma, id, workspaceId);
    }

    if (moduleRepoId) {
      await assertModuleRepoInWorkspace(
        this.prisma,
        moduleRepoId,
        moduleId,
        workspaceId,
      );
    }

    const integrationAccountIds = unique([
      integrationAccountId,
      ...bodies.map((body) => body?.integrationAccountId),
    ]);

    for (const id of integrationAccountIds) {
      await assertIntegrationAccountInWorkspace(this.prisma, id, workspaceId);
    }

    const capabilityIds = unique([
      capabilityId,
      ...bodies.map((body) => body?.capabilityId),
      ...bodies.flatMap((body) => list(body?.capabilityIds)),
    ]);

    for (const id of capabilityIds) {
      await assertCapabilityInWorkspace(this.prisma, id, workspaceId);
    }

    const linkedTeamIds = unique([
      ...bodies.map((body) => body?.ownerTeamId),
      ...bodies.flatMap((body) => list(body?.linkedTeamIds)),
      ...bodies.flatMap((body) => list(body?.teams)),
    ]);

    for (const id of linkedTeamIds) {
      await assertTeamInWorkspace(this.prisma, id, workspaceId);
    }

    const projectIds = unique([projectId, request.query?.projectId]);

    for (const id of projectIds) {
      await assertProjectInWorkspace(this.prisma, id, workspaceId);
    }

    if (projectMilestoneId) {
      await assertProjectMilestoneInWorkspace(
        this.prisma,
        projectMilestoneId,
        workspaceId,
      );
    }

    const labelIds = unique([labelId, ...bodies.map((body) => body?.groupId)]);

    for (const id of labelIds) {
      await assertLabelInWorkspace(this.prisma, id, workspaceId);
    }

    if (workflowId) {
      await assertWorkflowInWorkspace(this.prisma, workflowId, workspaceId);
    }

    if (viewId) {
      await assertViewInWorkspace(this.prisma, viewId, workspaceId);
    }

    const teamIds = await visibleTeamIds(this.prisma, userId, workspaceId);

    await assertTeamsVisible([...linkedTeamIds, ...requestTeamIds], teamIds);
    await assertIssuesVisible(this.prisma, issueIds, teamIds);
    await assertIssueCommentsVisible(
      this.prisma,
      issueCommentId ? [issueCommentId] : [],
      teamIds,
    );
    await assertChecklistItemsVisible(
      this.prisma,
      checklistItemId ? [checklistItemId] : [],
      teamIds,
    );
    await assertAgentQuestionsVisible(
      this.prisma,
      agentQuestionId ? [agentQuestionId] : [],
      teamIds,
    );
    await assertCyclesVisible(this.prisma, cycleIds, teamIds);
    await assertWorkflowsVisible(
      this.prisma,
      workflowId ? [workflowId] : [],
      teamIds,
    );

    return true;
  }
}

interface IdBearingBody {
  issueId?: string;
  teamId?: string;
  ownerTeamId?: string;
  ownerProductId?: string;
  capabilityId?: string;
  cycleId?: string;
  integrationAccountId?: string;
  groupId?: string;
  moduleIds?: unknown;
  capabilityIds?: unknown;
  linkedTeamIds?: unknown;
  linkedProductIds?: unknown;
  teams?: unknown;
  subIssues?: unknown;
}

const MAX_ISSUE_DEPTH = 10;

function issueBodies(body: unknown, depth = 0): IdBearingBody[] {
  if (!body || typeof body !== 'object' || depth > MAX_ISSUE_DEPTH) {
    return [];
  }

  const current = body as IdBearingBody;

  return [
    current,
    ...list(current.subIssues).flatMap((child) =>
      issueBodies(child, depth + 1),
    ),
  ];
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function unique(ids: unknown[]): string[] {
  return [
    ...new Set(
      ids.filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];
}

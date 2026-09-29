import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  AnswerKnowledgeGapDto,
  AssignKnowledgeInboxItemDto,
  CommentKnowledgeInboxItemDto,
  DecideKnowledgeInboxItemDto,
  type KnowledgeInboxDetail,
  type KnowledgeInboxList,
  KnowledgeInboxQueryDto,
  type KnowledgeAgreementReport,
  type KnowledgeReviewQueue,
  KnowledgeReviewQueryDto,
  parseReviewReasons,
  ResolveAuditDto,
  ResolveProposalDto,
  RoleEnum,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { resolveWorkspaceId } from 'common/workspace-access';

import { AuthGuard } from 'modules/auth/auth.guard';
import { Role, UserId, Workspace } from 'modules/auth/session.decorator';
import { WorkspaceResourceGuard } from 'modules/auth/workspace-resource.guard';

import KnowledgeInboxService from './knowledge-inbox.service';
import KnowledgeReviewService from './knowledge-review.service';
import KnowledgeAgreementService from './triage/knowledge-agreement.service';

/**
 * Where people review what triage could not settle, check a sample of what
 * it did, and see how far they and it agree.
 *
 * All of it is for people. An agent refused here is not refused anything it
 * needs to work: it can read every entry through the knowledge routes. It is
 * refused the reviewer's view, which says why each entry was held back and
 * so how to word the next one to get past the checks.
 */
@Controller({
  version: '1',
  path: 'knowledge',
})
export class KnowledgeReviewController {
  constructor(
    private review: KnowledgeReviewService,
    private agreement: KnowledgeAgreementService,
    private prisma: PrismaService,
    private inbox: KnowledgeInboxService,
  ) {}

  /** What waits on a person, with why, narrowed by `?reason=` when given. */
  @Get('review')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async queue(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Role() role: string,
    @Query() query: KnowledgeReviewQueryDto,
  ): Promise<KnowledgeReviewQueue> {
    forPeople(role);

    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      query.workspaceId,
    );

    return this.review.queue(workspaceId, {
      pageId: query.pageId,
      // Parsed again for the reason `status` is on the entries route: a
      // query string reaches the handler as a string however it validated.
      reasons: parseReviewReasons(query.reason),
    });
  }

  /** A person's answer to the gardener's proposal to archive an entry. */
  @Post('review/proposals/:proposalId')
  @UseGuards(AuthGuard)
  async resolveProposal(
    @Workspace() workspaceId: string,
    @UserId() userId: string,
    @Role() role: string,
    @Param('proposalId') proposalId: string,
    @Body() body: ResolveProposalDto,
  ) {
    forPeople(role);

    return this.review.resolveProposal(
      workspaceId,
      proposalId,
      userId,
      body.accept,
    );
  }

  /** A person answers a gap that agents could not close, with a fact. */
  @Post('gaps/:gapId/answer')
  @UseGuards(AuthGuard)
  async answerGap(
    @Workspace() workspaceId: string,
    @Role() role: string,
    @Param('gapId') gapId: string,
    @Body() body: AnswerKnowledgeGapDto,
  ) {
    forPeople(role);

    return this.review.answerGap(workspaceId, gapId, body.entryId);
  }

  /** A person's answer to an audit: was triage right to do what it did? */
  @Post('review/:decisionId/audit')
  @UseGuards(AuthGuard)
  async resolveAudit(
    @Workspace() workspaceId: string,
    @UserId() userId: string,
    @Role() role: string,
    @Param('decisionId') decisionId: string,
    @Body() body: ResolveAuditDto,
  ) {
    forPeople(role);

    return this.review.resolveAudit(
      workspaceId,
      decisionId,
      userId,
      body.agree,
    );
  }

  /**
   * Needs you: every knowledge decision that waits on a person, as one
   * inbox the workspace shares, with who is on each.
   */
  @Get('inbox')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async inboxList(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Role() role: string,
    @Query() query: KnowledgeInboxQueryDto,
  ): Promise<KnowledgeInboxList> {
    forPeople(role);

    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      query.workspaceId,
    );

    return this.inbox.list(workspaceId, userId, {
      view: query.view,
      pageId: query.pageId,
    });
  }

  /** One item of Needs you, with its thread and what deciding it needs. */
  @Get('inbox/:id')
  @UseGuards(AuthGuard)
  async inboxDetail(
    @Workspace() workspaceId: string,
    @Role() role: string,
    @Param('id') id: string,
  ): Promise<KnowledgeInboxDetail> {
    forPeople(role);

    return this.inbox.detail(workspaceId, id);
  }

  @Post('inbox/:id/assign')
  @UseGuards(AuthGuard)
  async inboxAssign(
    @Workspace() workspaceId: string,
    @UserId() userId: string,
    @Role() role: string,
    @Param('id') id: string,
    @Body() body: AssignKnowledgeInboxItemDto,
  ) {
    forPeople(role);

    return this.inbox.assign(workspaceId, userId, id, body.assigneeId ?? null);
  }

  @Post('inbox/:id/comments')
  @UseGuards(AuthGuard)
  async inboxComment(
    @Workspace() workspaceId: string,
    @UserId() userId: string,
    @Role() role: string,
    @Param('id') id: string,
    @Body() body: CommentKnowledgeInboxItemDto,
  ) {
    forPeople(role);

    return this.inbox.comment(workspaceId, userId, id, body.body);
  }

  @Post('inbox/:id/decide')
  @UseGuards(AuthGuard)
  async inboxDecide(
    @Workspace() workspaceId: string,
    @UserId() userId: string,
    @Role() role: string,
    @Param('id') id: string,
    @Body() body: DecideKnowledgeInboxItemDto,
  ) {
    forPeople(role);

    return this.inbox.decide(
      workspaceId,
      userId,
      id,
      body.choice,
      body.entryId,
    );
  }

  /**
   * Agreement between triage and people per decision type over the rolling
   * window, with the counts it rests on and whether each type is acting.
   */
  @Get('agreement')
  @UseGuards(AuthGuard)
  async agreementReport(
    @Workspace() workspaceId: string,
    @Role() role: string,
  ): Promise<KnowledgeAgreementReport> {
    forPeople(role);

    return this.agreement.report(
      workspaceId,
    ) as unknown as Promise<KnowledgeAgreementReport>;
  }
}

function forPeople(role: string) {
  if (role === RoleEnum.AGENT) {
    throw new ForbiddenException({
      message:
        'Review is for people: the queue, audits and agreement with triage ' +
        'are where the workspace decides what it believes.',
    });
  }
}

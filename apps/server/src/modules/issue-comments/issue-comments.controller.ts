import {
  Body,
  Controller,
  Delete,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CreateIssueCommentDto,
  CreateIssueCommentRequestParamsDto,
  IssueComment,
  IssueCommentRequestParamsDto,
  UpdateIssueCommentDto,
} from '@vantikhq/types';
import { SessionContainer } from 'supertokens-node/recipe/session';

import { AuthGuard } from 'modules/auth/auth.guard';
import { getAppUserId } from 'modules/auth/session-user';
import { Session as SessionDecorator } from 'modules/auth/session.decorator';
import { WorkspaceResourceGuard } from 'modules/auth/workspace-resource.guard';

import IssueCommentsService from './issue-comments.service';

@Controller({
  version: '1',
  path: 'issue_comments',
})
export class IssueCommentsController {
  constructor(private issueCommentsService: IssueCommentsService) {}

  @Post()
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async createIssueComment(
    @SessionDecorator() session: SessionContainer,
    @Query() issueParams: CreateIssueCommentRequestParamsDto,
    @Body() commentData: CreateIssueCommentDto,
  ): Promise<IssueComment> {
    const userId = getAppUserId(session);
    return await this.issueCommentsService.createIssueComment(
      issueParams,
      userId,
      commentData,
    );
  }

  @Post(':issueCommentId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async updateIssueComment(
    @Param() issueCommentParams: IssueCommentRequestParamsDto,
    @Body() commentData: UpdateIssueCommentDto,
  ): Promise<IssueComment> {
    return await this.issueCommentsService.updateIssueComment(
      issueCommentParams,
      commentData,
    );
  }

  @Delete(':issueCommentId')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async deleteIssueComment(
    @Param() issueCommentParams: IssueCommentRequestParamsDto,
  ): Promise<IssueComment> {
    return await this.issueCommentsService.deleteIssueComment(
      issueCommentParams,
    );
  }
}

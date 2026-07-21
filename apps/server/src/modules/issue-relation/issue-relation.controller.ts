import { Controller, Delete, Param, UseGuards } from '@nestjs/common';
import { IssueRelation, IssueRelationIdRequestDto } from '@vantikhq/types';
import { SessionContainer } from 'supertokens-node/recipe/session';

import { AuthGuard } from 'modules/auth/auth.guard';
import { getAppUserId } from 'modules/auth/session-user';
import { Session as SessionDecorator } from 'modules/auth/session.decorator';

import IssuesRelationService from './issue-relation.service';

@Controller({
  version: '1',
  path: 'issue_relation',
})
export class IssueRelationController {
  constructor(private issueRelation: IssuesRelationService) {}

  @Delete(':issueRelationId')
  @UseGuards(AuthGuard)
  async deleteLabel(
    @SessionDecorator() session: SessionContainer,
    @Param()
    issueRelationId: IssueRelationIdRequestDto,
  ): Promise<IssueRelation> {
    const userId = getAppUserId(session);
    return await this.issueRelation.deleteIssueRelation(
      userId,
      issueRelationId,
    );
  }
}

import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { IssueRequestParamsDto, TeamRequestParamsDto } from '@vantikhq/types';
import { Response } from 'express';
import { SessionContainer } from 'supertokens-node/recipe/session';

import { AuthGuard } from 'modules/auth/auth.guard';
import { getAppUserId } from 'modules/auth/session-user';
import { Session as SessionDecorator } from 'modules/auth/session.decorator';
import { WorkspaceResourceGuard } from 'modules/auth/workspace-resource.guard';

import IssuesAIService from './issues-ai.service';
import {
  AIInput,
  DescriptionInput,
  FilterInput,
  SubIssueInput,
} from './issues.interface';

@Controller({
  version: '1',
  path: 'issues/ai',
})
export class IssuesAIController {
  constructor(private issuesAiService: IssuesAIService) {}

  @Post('suggestions')
  @UseGuards(AuthGuard)
  async suggestions(
    @Query() teamRequestParams: TeamRequestParamsDto,
    @Body() suggestionsInput: AIInput,
  ) {
    return await this.issuesAiService.suggestions(
      teamRequestParams,
      suggestionsInput,
    );
  }

  /**
   * Promotes a suggested module to a module of the issue.
   *
   * `WorkspaceResourceGuard` reads `issueId` and `moduleId` from the path, so
   * an issue or a module of another workspace is refused before this runs.
   */
  @Post('suggestions/:issueId/modules/:moduleId/accept')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async acceptModuleSuggestion(
    @Param('issueId') issueId: string,
    @Param('moduleId') moduleId: string,
  ) {
    return await this.issuesAiService.acceptModuleSuggestion(issueId, moduleId);
  }

  /** Removes a suggested module, and remembers not to suggest it again. */
  @Post('suggestions/:issueId/modules/:moduleId/dismiss')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async dismissModuleSuggestion(
    @Param('issueId') issueId: string,
    @Param('moduleId') moduleId: string,
  ) {
    return await this.issuesAiService.dismissModuleSuggestion(
      issueId,
      moduleId,
    );
  }

  /**
   * Builds a filter from a sentence.
   *
   * Takes the caller's id because the labels and the people it offers are
   * drawn from real teams, and a team is a visibility boundary. Without it the
   * suggestions are assembled from every team in the workspace.
   */
  @Post('ai_filters')
  @UseGuards(AuthGuard)
  async aiFilters(
    @Body() filterInput: FilterInput,
    @SessionDecorator() session: SessionContainer,
  ) {
    return await this.issuesAiService.aiFilters(
      filterInput,
      getAppUserId(session),
    );
  }

  @Post('ai_title')
  @UseGuards(AuthGuard)
  async aiTitle(@Body() aiInput: AIInput) {
    return await this.issuesAiService.aiTitle(aiInput);
  }

  @Post('subissues/generate')
  @UseGuards(AuthGuard)
  async generateSubIssues(@Body() issueInput: SubIssueInput) {
    return await this.issuesAiService.generateSubIssues(issueInput);
  }

  @Post('stream/description')
  @UseGuards(AuthGuard)
  async generateDescriptionStream(
    @Body() descriptionInput: DescriptionInput,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.issuesAiService.getDescriptionStream(descriptionInput, response);
  }

  @Get(':issueId/summarize')
  @UseGuards(AuthGuard, WorkspaceResourceGuard)
  async summarizeIssue(@Param() issueParams: IssueRequestParamsDto) {
    return await this.issuesAiService.summarizeIssue(issueParams.issueId);
  }
}

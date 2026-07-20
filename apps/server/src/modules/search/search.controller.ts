import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { AuthGuard } from 'modules/auth/auth.guard';
import { UserId, Workspace } from 'modules/auth/session.decorator';

import {
  SearchInputData,
  SimilarIssueData,
  parseSearchLimit,
  parseStateCategories,
  parseVectorDistance,
} from './search.interface';
import SearchService from './search.service';

@Controller({
  version: '1',
  path: 'search',
})
export class SearchController {
  constructor(private searchService: SearchService) {}

  @Get()
  @UseGuards(AuthGuard)
  async search(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Query() searchData: SearchInputData,
  ) {
    return await this.searchService.searchData(
      sessionWorkspaceId,
      userId,
      searchData.workspaceId,
      searchData.query,
      parseSearchLimit(searchData.limit),
      parseVectorDistance(searchData.threshold),
      parseStateCategories(searchData.stateCategory),
    );
  }

  @Get('similar_issues')
  @UseGuards(AuthGuard)
  async similarIssue(
    @Workspace() sessionWorkspaceId: string,
    @UserId() userId: string,
    @Query() similarIssueData: SimilarIssueData,
  ) {
    return await this.searchService.similarData(
      sessionWorkspaceId,
      userId,
      similarIssueData.workspaceId,
      similarIssueData.issueId,
    );
  }
}

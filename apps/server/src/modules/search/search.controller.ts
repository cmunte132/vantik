import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { AuthGuard } from 'modules/auth/auth.guard';

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
  async search(@Query() searchData: SearchInputData) {
    return await this.searchService.searchData(
      searchData.workspaceId,
      searchData.query,
      parseSearchLimit(searchData.limit),
      parseVectorDistance(searchData.threshold),
      parseStateCategories(searchData.stateCategory),
    );
  }

  @Get('similar_issues')
  @UseGuards(AuthGuard)
  async similarIssue(@Query() similarIssueData: SimilarIssueData) {
    return await this.searchService.similarData(
      similarIssueData.workspaceId,
      similarIssueData.issueId,
    );
  }
}

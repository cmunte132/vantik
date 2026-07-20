import { Injectable } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import { resolveWorkspaceId } from 'common/workspace-access';

import { VectorService } from 'modules/vector/vector.service';

@Injectable()
export default class SearchService {
  constructor(
    private vectorService: VectorService,
    private prisma: PrismaService,
  ) {}

  async searchData(
    sessionWorkspaceId: string,
    userId: string,
    requestedWorkspaceId: string | undefined,
    query: string,
    limit: number = 10,
    vectorDistance: number,
    stateCategories: string[] = [],
  ) {
    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      requestedWorkspaceId,
    );

    const searchData = await this.vectorService.searchEmbeddings(
      workspaceId,
      query,
      limit,
      vectorDistance,
      stateCategories,
    );

    return searchData;
  }

  async similarData(
    sessionWorkspaceId: string,
    userId: string,
    requestedWorkspaceId: string | undefined,
    issueId: string,
  ) {
    const workspaceId = await resolveWorkspaceId(
      this.prisma,
      userId,
      sessionWorkspaceId,
      requestedWorkspaceId,
    );

    const similarIssues = await this.vectorService.similarIssues(
      workspaceId,
      issueId,
    );

    return similarIssues;
  }
}

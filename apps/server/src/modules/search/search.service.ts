import { Injectable } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import { visibleTeamIds } from 'common/team-access';
import { resolveWorkspaceId } from 'common/workspace-access';

import { AxisFilter } from 'modules/vector/vector.interface';
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
    axis: AxisFilter = {},
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
      // The axis ids come from the caller, so they are checked against this
      // workspace before they reach the query. A module of another workspace
      // otherwise narrows this search to nothing, which reads as "no results"
      // rather than as the mistake it is.
      await this.axisInWorkspace(axis, workspaceId),
      // A team is a visibility boundary (ENG-79). Search is the widest read in
      // the product — it crosses every team by design — so it is the one that
      // needs the limit most.
      await visibleTeamIds(this.prisma, userId, workspaceId),
    );

    return searchData;
  }

  /**
   * This method returns the parts of an axis filter that this workspace holds.
   *
   * A module or a capability that belongs to another workspace is dropped. The
   * search then runs without it, rather than with a filter that can never
   * match.
   */
  private async axisInWorkspace(
    axis: AxisFilter,
    workspaceId: string,
  ): Promise<AxisFilter> {
    const [modules, capability] = await Promise.all([
      axis.moduleIds?.length
        ? this.prisma.module.findMany({
            where: { id: { in: axis.moduleIds }, workspaceId, deleted: null },
            select: { id: true },
          })
        : Promise.resolve([]),
      axis.capabilityId
        ? this.prisma.capability.findFirst({
            where: { id: axis.capabilityId, workspaceId, deleted: null },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);

    return {
      ...(modules.length ? { moduleIds: modules.map((row) => row.id) } : {}),
      ...(capability ? { capabilityId: capability.id } : {}),
    };
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
      await visibleTeamIds(this.prisma, userId, workspaceId),
    );

    return similarIssues;
  }
}

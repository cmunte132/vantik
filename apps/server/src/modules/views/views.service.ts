import { Injectable } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import { resolveWorkspaceId } from 'common/workspace-access';

import {
  CreateViewsRequestBody,
  UpdateViewsRequestBody,
} from './views.interface';

@Injectable()
export class ViewsService {
  constructor(private prismaService: PrismaService) {}

  async getViews(
    sessionWorkspaceId: string,
    userId: string,
    requestedWorkspaceId?: string,
  ) {
    const workspaceId = await resolveWorkspaceId(
      this.prismaService,
      userId,
      sessionWorkspaceId,
      requestedWorkspaceId,
    );

    return await this.prismaService.view.findMany({
      where: {
        workspaceId,
      },
    });
  }

  async createView(
    {
      workspaceId: requestedWorkspaceId,
      filters,
      teamId,
      name,
      description,
    }: CreateViewsRequestBody,
    createdById: string,
    sessionWorkspaceId: string,
  ) {
    // A write is worse than a read here: an unchecked workspaceId let a caller
    // create views inside a workspace they have no part in.
    const workspaceId = await resolveWorkspaceId(
      this.prismaService,
      createdById,
      sessionWorkspaceId,
      requestedWorkspaceId,
    );

    return await this.prismaService.view.create({
      data: {
        name,
        // TODO should take normally without the any
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        filters: filters as any,
        workspace: { connect: { id: workspaceId } },
        team: teamId ? { connect: { id: teamId } } : undefined,
        isBookmarked: false,
        createdById,
        description: description ?? '',
      },
    });
  }

  async updateView(
    viewId: string,
    { filters, ...data }: UpdateViewsRequestBody,
  ) {
    return await this.prismaService.view.update({
      data: {
        ...data,
        // TODO should take normally without the any
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        filters: filters as any,
      },
      where: {
        id: viewId,
      },
    });
  }

  async getViewById(viewId: string) {
    return await this.prismaService.view.findUnique({
      where: {
        id: viewId,
      },
    });
  }

  async deleteView(viewId: string) {
    return await this.prismaService.view.update({
      where: {
        id: viewId,
      },
      data: {
        deleted: new Date(),
      },
    });
  }
}

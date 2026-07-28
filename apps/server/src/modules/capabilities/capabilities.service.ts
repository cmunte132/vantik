import { Injectable } from '@nestjs/common';
import { CreateCapabilityDto, UpdateCapabilityDto } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

// A capability that nobody has given a status to is one that nobody has built.
const DEFAULT_CAPABILITY_STATUS = 'planned';

@Injectable()
export class CapabilitiesService {
  constructor(private prisma: PrismaService) {}

  async getCapabilities(workspaceId: string) {
    return await this.prisma.capability.findMany({
      where: { workspaceId, deleted: null },
      orderBy: { name: 'asc' },
    });
  }

  async createCapability(
    createCapabilityDto: CreateCapabilityDto,
    workspaceId: string,
  ) {
    return await this.prisma.capability.create({
      data: {
        ...createCapabilityDto,
        moduleIds: createCapabilityDto.moduleIds ?? [],
        status: createCapabilityDto.status ?? DEFAULT_CAPABILITY_STATUS,
        workspace: { connect: { id: workspaceId } },
      },
    });
  }

  async updateCapability(
    updateCapabilityDto: UpdateCapabilityDto,
    capabilityId: string,
  ) {
    return await this.prisma.capability.update({
      where: { id: capabilityId },
      data: updateCapabilityDto,
    });
  }

  /**
   * Deletes a capability, and takes its id off the rows that name it.
   *
   * The delete is soft, so the foreign key on Issue.capabilityId never fires and
   * the id stays in Project.capabilityIds. Both would then point at a row that
   * the app hides, which reads on screen as a capability nobody can open or
   * remove.
   */
  async deleteCapability(capabilityId: string) {
    const projects = await this.prisma.project.findMany({
      where: { capabilityIds: { has: capabilityId }, deleted: null },
      select: { id: true, capabilityIds: true },
    });

    await Promise.all([
      this.prisma.issue.updateMany({
        where: { capabilityId },
        data: { capabilityId: null },
      }),
      ...projects.map((project) =>
        this.prisma.project.update({
          where: { id: project.id },
          data: {
            capabilityIds: project.capabilityIds.filter(
              (id) => id !== capabilityId,
            ),
          },
        }),
      ),
    ]);

    return await this.prisma.capability.update({
      where: { id: capabilityId },
      data: { deleted: new Date().toISOString() },
    });
  }
}

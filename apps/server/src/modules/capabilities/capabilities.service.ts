import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
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
    await this.assertNameFree(workspaceId, createCapabilityDto.name);

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
    const current = await this.prisma.capability.findFirst({
      where: { id: capabilityId, deleted: null },
      select: { workspaceId: true, name: true },
    });

    if (!current) {
      throw new NotFoundException({
        message: `Capability ${capabilityId} not found`,
      });
    }

    if (updateCapabilityDto.name && updateCapabilityDto.name !== current.name) {
      await this.assertNameFree(current.workspaceId, updateCapabilityDto.name);
    }

    return await this.prisma.capability.update({
      where: { id: capabilityId },
      data: updateCapabilityDto,
    });
  }

  /**
   * Refuses a name that this workspace already uses for a capability.
   *
   * A name is the identity of a capability — there is no key to fall back on —
   * so a repeat cannot be quietly renamed the way a product key can. The unique
   * index says the same thing, and without this the caller saw it as a 500 with
   * a constraint name in it rather than as a sentence.
   *
   * The count covers the deleted rows too, because the index does. A name held
   * by a deleted capability is one this workspace cannot use again, and saying
   * so is better than an insert that fails.
   */
  private async assertNameFree(
    workspaceId: string,
    name: string,
  ): Promise<void> {
    if (!name) {
      return;
    }

    const clash = await this.prisma.capability.findFirst({
      where: { workspaceId, name },
      select: { id: true, deleted: true },
    });

    if (!clash) {
      return;
    }

    throw new BadRequestException({
      message: clash.deleted
        ? `A deleted capability still holds the name "${name}". Give this one another name.`
        : `This workspace already has a capability called "${name}".`,
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

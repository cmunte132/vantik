import { Injectable, NotFoundException } from '@nestjs/common';
import {
  CreateModuleDto,
  CreateModuleRepoDto,
  UpdateModuleDto,
  UpdateModuleRepoDto,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import {
  assertSingleOwner,
  forgetModule,
  toKey,
  uniqueKey,
} from 'common/product-axis';

const DEFAULT_MODULE_STATUS = 'active';

@Injectable()
export class ModulesService {
  constructor(private prisma: PrismaService) {}

  async getModules(workspaceId: string) {
    return await this.prisma.module.findMany({
      where: { workspaceId, deleted: null },
      orderBy: { name: 'asc' },
    });
  }

  async createModule(createModuleDto: CreateModuleDto, workspaceId: string) {
    assertSingleOwner(
      createModuleDto.ownerTeamId,
      createModuleDto.ownerProductId,
    );

    const key = await uniqueKey(
      toKey(createModuleDto.key ?? createModuleDto.name, 'module'),
      (candidate) => this.keyTaken(workspaceId, candidate),
    );

    // workspaceId is set here rather than through `workspace: { connect }`:
    // Prisma refuses a create that mixes a relation with the scalar keys of
    // another relation, and ownerTeamId and ownerProductId are exactly that.
    return await this.prisma.module.create({
      data: {
        ...createModuleDto,
        key,
        status: createModuleDto.status ?? DEFAULT_MODULE_STATUS,
        linkedTeamIds: createModuleDto.linkedTeamIds ?? [],
        linkedProductIds: createModuleDto.linkedProductIds ?? [],
        workspaceId,
      },
    });
  }

  /**
   * Updates a module, and checks the owner that the change leaves behind.
   *
   * A caller who moves a module from a team to a product sends both fields: the
   * new product, and null for the team. A caller who changes only the name sends
   * neither. So the check runs on the row as it will be, and not on the request.
   *
   * A rename gets a free key the same way create does, because the unique index
   * refuses a repeat on update just as it does on insert.
   */
  async updateModule(updateModuleDto: UpdateModuleDto, moduleId: string) {
    const current = await this.prisma.module.findFirst({
      where: { id: moduleId, deleted: null },
      select: {
        workspaceId: true,
        key: true,
        ownerTeamId: true,
        ownerProductId: true,
      },
    });

    // A missing row read as a TypeError on the next line, which surfaced as a
    // 500 for what is an ordinary not-found.
    if (!current) {
      throw new NotFoundException({ message: `Module ${moduleId} not found` });
    }

    const ownerTeamId =
      updateModuleDto.ownerTeamId === undefined
        ? current.ownerTeamId
        : updateModuleDto.ownerTeamId;
    const ownerProductId =
      updateModuleDto.ownerProductId === undefined
        ? current.ownerProductId
        : updateModuleDto.ownerProductId;

    assertSingleOwner(ownerTeamId, ownerProductId);

    const requested = updateModuleDto.key
      ? toKey(updateModuleDto.key, 'module')
      : undefined;

    const key =
      requested && requested !== current.key
        ? await uniqueKey(requested, (candidate) =>
            this.keyTaken(current.workspaceId, candidate),
          )
        : undefined;

    return await this.prisma.module.update({
      where: { id: moduleId },
      data: {
        ...updateModuleDto,
        ownerTeamId,
        ownerProductId,
        ...(key ? { key } : {}),
      },
    });
  }

  /**
   * Reports whether a key is in use, counting the deleted rows too.
   *
   * Deletion is soft and the unique index is not partial, so a deleted module
   * still holds its key against the workspace.
   */
  private async keyTaken(workspaceId: string, key: string): Promise<boolean> {
    return (
      (await this.prisma.module.count({ where: { workspaceId, key } })) > 0
    );
  }

  async deleteModule(moduleId: string) {
    await forgetModule(this.prisma, moduleId);

    // The repositories go with the module. They describe where its code is, and
    // that statement has no meaning once the module is gone.
    await this.prisma.moduleRepo.updateMany({
      where: { moduleId, deleted: null },
      data: { deleted: new Date().toISOString() },
    });

    return await this.prisma.module.update({
      where: { id: moduleId },
      data: { deleted: new Date().toISOString() },
    });
  }

  async getModuleRepos(moduleId: string) {
    return await this.prisma.moduleRepo.findMany({
      where: { moduleId, deleted: null },
      orderBy: { fullName: 'asc' },
    });
  }

  async createModuleRepo(
    createModuleRepoDto: CreateModuleRepoDto,
    moduleId: string,
  ) {
    return await this.prisma.moduleRepo.create({
      data: {
        ...createModuleRepoDto,
        // An empty list is the ordinary case: the module is all of the
        // repository, which is what a small repository looks like.
        pathPrefixes: normalisePrefixes(createModuleRepoDto.pathPrefixes),
        moduleId,
      },
    });
  }

  async updateModuleRepo(
    updateModuleRepoDto: UpdateModuleRepoDto,
    moduleRepoId: string,
  ) {
    return await this.prisma.moduleRepo.update({
      where: { id: moduleRepoId },
      data: {
        ...updateModuleRepoDto,
        ...(updateModuleRepoDto.pathPrefixes
          ? { pathPrefixes: normalisePrefixes(updateModuleRepoDto.pathPrefixes) }
          : {}),
      },
    });
  }

  async deleteModuleRepo(moduleRepoId: string) {
    return await this.prisma.moduleRepo.update({
      where: { id: moduleRepoId },
      data: { deleted: new Date().toISOString() },
    });
  }
}

/**
 * Makes a path prefix match the way a webhook compares it.
 *
 * A changed file arrives as a path with no leading slash, and the comparison is
 * a plain "starts with". So "/apps/server" and "apps/server" have to become one
 * thing before they are stored, or the first one matches no file and the person
 * who typed it sees a module that never gets tagged.
 */
function normalisePrefixes(prefixes: string[] = []): string[] {
  const cleaned = prefixes
    .map((prefix) => prefix.trim().replace(/^\/+/, ''))
    .filter(Boolean)
    .map((prefix) => (prefix.endsWith('/') ? prefix : `${prefix}/`));

  return [...new Set(cleaned)];
}

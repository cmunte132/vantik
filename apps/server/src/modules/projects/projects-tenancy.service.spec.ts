/**
 * Tenancy scoping for project writes.
 *
 * `POST /v1/projects/:projectId` names its target by id alone, and the service
 * behind it used to issue `prisma.project.update({ where: { id } })` — no
 * workspace in the predicate. Any caller holding a valid session could rewrite
 * the name, description, status or lead of a project belonging to a workspace
 * they had never been a member of. Same class of hole as ENG-18..ENG-23.
 *
 * The invariant these tests protect: the workspace is always part of the
 * predicate, a project outside it is a 404 rather than a write, and the 404
 * does not disclose whether the id exists elsewhere.
 */
import { NotFoundException } from '@nestjs/common';
import { UpdateProjectDto } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import IssuesService from 'modules/issues/issues.service';

import { ProjectsService } from './projects.service';

const MY_WORKSPACE = 'workspace-mine';
const THEIR_WORKSPACE = 'workspace-theirs';
const PROJECT = 'project-theirs';

/** `livesIn` is the workspace the one existing project actually belongs to. */
function buildService(livesIn: string) {
  const prisma = {
    project: {
      // Mirrors Prisma: updateMany reports how many rows the predicate hit.
      updateMany: jest.fn(({ where }) =>
        Promise.resolve({
          count: where.id === PROJECT && where.workspaceId === livesIn ? 1 : 0,
        }),
      ),
      findUnique: jest.fn(() =>
        Promise.resolve({ id: PROJECT, workspaceId: livesIn }),
      ),
    },
  } as unknown as PrismaService;

  const service = new ProjectsService(prisma, null as unknown as IssuesService);

  return { service, prisma };
}

const whereOf = (prisma: PrismaService) =>
  (prisma.project.updateMany as jest.Mock).mock.calls[0][0].where;

describe('ProjectsService.updateProject tenancy', () => {
  it('puts the caller’s workspace in the predicate', async () => {
    const { service, prisma } = buildService(MY_WORKSPACE);

    await service.updateProject(
      { status: 'Completed' } as UpdateProjectDto,
      PROJECT,
      MY_WORKSPACE,
    );

    expect(whereOf(prisma)).toMatchObject({
      id: PROJECT,
      workspaceId: MY_WORKSPACE,
    });
  });

  it('refuses a project id from another workspace', async () => {
    const { service } = buildService(THEIR_WORKSPACE);

    await expect(
      service.updateProject(
        { name: 'Hijacked' } as UpdateProjectDto,
        PROJECT,
        MY_WORKSPACE,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('writes nothing when the workspace does not match', async () => {
    const { service, prisma } = buildService(THEIR_WORKSPACE);

    await service
      .updateProject(
        { name: 'Hijacked' } as UpdateProjectDto,
        PROJECT,
        MY_WORKSPACE,
      )
      .catch((): undefined => undefined);

    // updateMany was issued, but scoped — so it matched nothing and the row is
    // untouched. What must never happen is a second, unscoped write.
    expect(prisma.project.updateMany).toHaveBeenCalledTimes(1);
    expect(whereOf(prisma).workspaceId).toBe(MY_WORKSPACE);
    expect(prisma.project.findUnique).not.toHaveBeenCalled();
  });

  it('says the same thing whether the id is unknown or merely elsewhere', async () => {
    const elsewhere = buildService(THEIR_WORKSPACE);
    const unknown = buildService(MY_WORKSPACE);

    const fromElsewhere = await elsewhere.service
      .updateProject({} as UpdateProjectDto, PROJECT, MY_WORKSPACE)
      .catch((error: NotFoundException) => error.getResponse());
    const fromUnknown = await unknown.service
      .updateProject({} as UpdateProjectDto, 'project-nowhere', MY_WORKSPACE)
      .catch((error: NotFoundException) => error.getResponse());

    // A different message for "exists, not yours" would leak the existence of
    // projects in workspaces the caller cannot see.
    expect(fromElsewhere).toEqual({ message: `Project ${PROJECT} not found` });
    expect(fromUnknown).toEqual({
      message: 'Project project-nowhere not found',
    });
  });

  it('skips soft-deleted projects', async () => {
    const { service, prisma } = buildService(MY_WORKSPACE);

    await service.updateProject(
      { status: 'Completed' } as UpdateProjectDto,
      PROJECT,
      MY_WORKSPACE,
    );

    expect(whereOf(prisma)).toMatchObject({ deleted: null });
  });
});

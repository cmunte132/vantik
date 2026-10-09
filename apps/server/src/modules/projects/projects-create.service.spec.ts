/**
 * A project name is unique within a workspace. Creating a second project with
 * a name already taken threw Prisma's unique error, which reached the caller as
 * a 500 for what is the caller's own mistake.
 */
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CreateProjectDto } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import IssuesService from 'modules/issues/issues.service';

import { ProjectsService } from './projects.service';

function buildService(create: jest.Mock) {
  const prisma = { project: { create } } as unknown as PrismaService;

  return new ProjectsService(prisma, null as unknown as IssuesService);
}

const dto = { name: 'Roadmap' } as CreateProjectDto;

describe('ProjectsService.createProject', () => {
  it('answers 409 with a message when the name exists in the workspace', async () => {
    const create = jest.fn().mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    const attempt = buildService(create).createProject(dto, 'ws-1');

    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toThrow('"Roadmap" already exists');
  });

  it('lets any other database error through', async () => {
    const failure = new Error('connection lost');
    const create = jest.fn().mockRejectedValue(failure);

    await expect(buildService(create).createProject(dto, 'ws-1')).rejects.toBe(
      failure,
    );
  });

  it('creates the project when the name is free', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'p-1' });

    await expect(
      buildService(create).createProject(dto, 'ws-1'),
    ).resolves.toEqual({ id: 'p-1' });
  });
});

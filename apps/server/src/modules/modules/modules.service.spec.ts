/**
 * Where a module's code is decides which knowledge entries are about it. An
 * edit to that has to reach the entries, or "what do we know about this
 * module" answers from the repositories as they were.
 */
import { BadRequestException } from '@nestjs/common';
import { Queue } from 'bull';
import { PrismaService } from 'nestjs-prisma';

import {
  GitSourcesService,
  type RepoRef,
} from 'modules/git/git-sources.service';
import { RepoMirrorService } from 'modules/git/repo-mirror.service';
import { RECOMPUTE_MODULES_JOB } from 'modules/pages/pages.interface';

import { ModulesService } from './modules.service';

function build(
  queueAdd: jest.Mock = jest.fn(async (): Promise<void> => undefined),
) {
  const repo = {
    id: 'repo-1',
    moduleId: 'module-1',
    module: { workspaceId: 'workspace-1' },
  };
  const prisma = {
    moduleRepo: {
      create: jest.fn(async () => repo),
      update: jest.fn(async () => repo),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    module: {
      findFirst: jest.fn(async () => ({ workspaceId: 'workspace-1' })),
      update: jest.fn(async () => ({
        id: 'module-1',
        workspaceId: 'workspace-1',
      })),
    },
    // forgetModule's clean-up of the rows that name the module.
    issue: { findMany: jest.fn(async (): Promise<unknown[]> => []) },
    capability: { findMany: jest.fn(async (): Promise<unknown[]> => []) },
  } as unknown as PrismaService;
  const queue = { add: queueAdd } as unknown as Queue;
  const require = jest.fn(async (ref: RepoRef) => {
    if (ref.integrationAccountId !== 'account-1') {
      throw new BadRequestException(
        'This repository cannot be used: the source of the repository is no longer connected.',
      );
    }

    return {
      source: {},
      repo: {
        integrationAccountId: 'account-1',
        fullName: 'acme/app',
        externalRepoId: ref.externalRepoId,
      },
    };
  });
  const gitSources = { require } as unknown as GitSourcesService;

  return {
    service: new ModulesService(
      prisma,
      gitSources,
      {} as RepoMirrorService,
      queue,
    ),
    queueAdd,
    prisma,
    require,
  };
}

describe('ModulesService and knowledge scopes', () => {
  it('[KG-1.2] asks for the workspace’s entries to be re-resolved after any repository edit', async () => {
    const { service, queueAdd } = build();

    await service.createModuleRepo(
      {
        externalRepoId: 'r1',
        fullName: 'acme/app',
        integrationAccountId: 'account-1',
        pathPrefixes: ['apps/x'],
      },
      'module-1',
    );
    await service.updateModuleRepo({ pathPrefixes: ['apps/y'] }, 'repo-1');
    await service.deleteModuleRepo('repo-1');
    await service.deleteModule('module-1');

    expect(queueAdd.mock.calls.map(([name, data]) => [name, data])).toEqual(
      Array(4).fill([RECOMPUTE_MODULES_JOB, { workspaceId: 'workspace-1' }]),
    );
    // Folded per workspace: the id names the workspace, so a burst of edits
    // queues one pass for it and never swallows another workspace's.
    for (const [, , options] of queueAdd.mock.calls) {
      expect(options.jobId).toMatch(
        new RegExp(`^${RECOMPUTE_MODULES_JOB}:workspace-1:\\d+$`),
      );
    }
  });

  it('[KG-1.2] never fails the edit when the queue is down', async () => {
    const { service } = build(
      jest.fn(async (): Promise<void> => {
        throw new Error('redis is down');
      }),
    );

    await expect(
      service.updateModuleRepo({ pathPrefixes: ['apps/y'] }, 'repo-1'),
    ).resolves.toMatchObject({ id: 'repo-1' });
  });
});

describe('ModulesService repository links', () => {
  it('refuses a link to a repository no connected source offers, and writes nothing', async () => {
    const { service, prisma } = build();

    await expect(
      service.createModuleRepo(
        {
          externalRepoId: '3',
          fullName: 'cmunte/perk-pilot',
          integrationAccountId: 'not-an-account',
        },
        'module-1',
      ),
    ).rejects.toThrow(/cannot be used/);
    expect(prisma.moduleRepo.create).not.toHaveBeenCalled();
  });

  it('names the repository the way the source does', async () => {
    const { service, prisma } = build();

    await service.createModuleRepo(
      {
        externalRepoId: 'r1',
        fullName: 'typed by hand',
        integrationAccountId: 'account-1',
      },
      'module-1',
    );

    expect(prisma.moduleRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fullName: 'acme/app',
          integrationAccountId: 'account-1',
        }),
      }),
    );
  });
});

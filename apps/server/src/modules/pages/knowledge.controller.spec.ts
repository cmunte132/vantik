import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  KnowledgeSearchQueryDto,
  ListPageEntriesQueryDto,
  RoleEnum,
} from '@vantikhq/types';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from 'nestjs-prisma';

import { AgentScopeGuard } from 'modules/auth/agent-scope.guard';

import { KnowledgeController } from './knowledge.controller';
import { PageEntriesController } from './page-entries.controller';
import type KnowledgeService from './knowledge.service';
import type PageEntriesService from './page-entries.service';

describe('KnowledgeController', () => {
  it('trims and rejects empty or wildcard search queries', async () => {
    const blank = plainToInstance(KnowledgeSearchQueryDto, { query: '   ' });
    const wildcard = plainToInstance(KnowledgeSearchQueryDto, { query: ' * ' });
    const valid = plainToInstance(KnowledgeSearchQueryDto, {
      query: '  deployment runbook  ',
    });

    await expect(validate(blank)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ property: 'query' })]),
    );
    await expect(validate(wildcard)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ property: 'query' })]),
    );
    await expect(validate(valid)).resolves.toEqual([]);
    expect(valid.query).toBe('deployment runbook');
  });

  it('drops invalid limits before calling the search service', async () => {
    const knowledgeService = {
      search: jest.fn().mockResolvedValue({ hits: [], pages: [] }),
    } as unknown as KnowledgeService;
    const controller = new KnowledgeController(
      knowledgeService,
      {} as PrismaService,
    );
    const controllerWithWorkspace = controller as unknown as {
      workspace: (
        userId: string,
        sessionWorkspaceId: string,
        requested?: string,
      ) => Promise<string>;
    };

    jest
      .spyOn(controllerWithWorkspace, 'workspace')
      .mockResolvedValue('workspace-1');

    await controller.search('session-workspace', 'user-1', {
      query: 'deployment',
      limit: 'NaN',
    } as KnowledgeSearchQueryDto);

    expect(knowledgeService.search).toHaveBeenCalledWith(
      'workspace-1',
      'deployment',
      { limit: undefined, scope: undefined },
    );
  });
});

describe('agent scopes on the knowledge routes', () => {
  const TOKEN = 'tg_pat_agent';

  /** The real guard and the real reflector, so the decorators are what count. */
  function guardForAgentWith(scopes: string[]) {
    const prisma = {
      personalAccessToken: {
        update: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue({
          id: 'pat-1',
          lastUsedAt: null,
          userId: 'agent-1',
          workspaceId: 'ws-1',
          user: {
            authIdentities: [{ supertokensUserId: 'st-1' }],
            usersOnWorkspaces: [
              {
                workspaceId: 'ws-1',
                role: RoleEnum.AGENT,
                settings: { agent: { scopes } },
              },
            ],
          },
        }),
      },
    } as unknown as PrismaService;

    return new AgentScopeGuard(prisma, new Reflector());
  }

  function request(
    controller: object,
    handler: (...args: never[]) => unknown,
    method: string,
  ) {
    return {
      getType: () => 'http',
      getHandler: () => handler,
      getClass: () => controller,
      switchToHttp: () => ({
        getRequest: () => ({
          method,
          headers: { authorization: `Bearer ${TOKEN}` },
        }),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it('[KG-0.4] lets a read-only agent load context, though the route is a POST', async () => {
    const guard = guardForAgentWith(['read']);

    await expect(
      guard.canActivate(
        request(
          KnowledgeController,
          KnowledgeController.prototype.contextPack,
          'POST',
        ),
      ),
    ).resolves.toBe(true);
  });

  it('[KG-0.4] still holds a read-only agent to the routes that write', async () => {
    const guard = guardForAgentWith(['read']);

    // The declaration opens the one read that arrives as a POST, not POSTs in
    // general: appending an entry is still a write.
    await expect(
      guard.canActivate(
        request(
          PageEntriesController,
          PageEntriesController.prototype.createEntry,
          'POST',
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('KnowledgeController.search', () => {
  it('[KG-1.4] hands the kinds, modules and issue asked for to the search', async () => {
    const knowledgeService = {
      search: jest.fn().mockResolvedValue({ hits: [] }),
    } as unknown as KnowledgeService;
    const controller = new KnowledgeController(
      knowledgeService,
      {} as PrismaService,
    );
    jest
      .spyOn(
        controller as unknown as { workspace: () => Promise<string> },
        'workspace',
      )
      .mockResolvedValue('workspace-1');

    // The query string as the DTO leaves it: lists already split.
    const query = plainToInstance(KnowledgeSearchQueryDto, {
      query: 'migrations',
      kind: 'CONVENTION,GOTCHA',
      moduleIds: '22222222-2222-4222-8222-000000000001',
      issueId: '22222222-2222-4222-8222-000000000002',
    });
    await expect(validate(query)).resolves.toEqual([]);

    await controller.search('session-workspace', 'user-1', query);

    expect(knowledgeService.search).toHaveBeenCalledWith(
      'workspace-1',
      'migrations',
      expect.objectContaining({
        kinds: ['CONVENTION', 'GOTCHA'],
        moduleIds: ['22222222-2222-4222-8222-000000000001'],
        issueId: '22222222-2222-4222-8222-000000000002',
      }),
    );
  });

  it('[KG-1.4] rejects a kind that does not exist', async () => {
    const query = plainToInstance(KnowledgeSearchQueryDto, {
      query: 'migrations',
      kind: 'OPINION',
    });

    await expect(validate(query)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ property: 'kind' })]),
    );
  });
});

describe('PageEntriesController.getEntries', () => {
  it('[KG-1.6] hands the modules, statuses and limit asked for to the list', async () => {
    const pageEntriesService = {
      getEntries: jest.fn().mockResolvedValue([]),
    } as unknown as PageEntriesService;
    const prisma = {
      usersOnWorkspaces: {
        findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }),
      },
    } as unknown as PrismaService;
    const controller = new PageEntriesController(pageEntriesService, prisma);

    // The query string as a product-axis screen sends it.
    const query = plainToInstance(ListPageEntriesQueryDto, {
      status: 'STANDING',
      moduleIds: '22222222-2222-4222-8222-000000000001',
      limit: '50',
    });
    await expect(validate(query)).resolves.toEqual([]);

    await controller.getEntries('workspace-1', 'user-1', query);

    expect(pageEntriesService.getEntries).toHaveBeenCalledWith('workspace-1', {
      pageId: undefined,
      status: ['STANDING'],
      moduleIds: ['22222222-2222-4222-8222-000000000001'],
      limit: 50,
    });
  });
});

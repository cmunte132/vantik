import type KnowledgeService from './knowledge.service';
import type PageEntriesService from './page-entries.service';

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

import KnowledgeOverviewService from './knowledge-overview.service';
import LooseFactsService from './loose-facts.service';
import { KnowledgeController } from './knowledge.controller';
import { PageEntriesController } from './page-entries.controller';
import { harnessSessionOf } from './pages.interface';

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
      {} as KnowledgeOverviewService,
      {} as LooseFactsService,
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

    await controller.search('session-workspace', 'user-1', null, undefined, {
      query: 'deployment',
      limit: 'NaN',
    } as KnowledgeSearchQueryDto);

    expect(knowledgeService.search).toHaveBeenCalledWith(
      'workspace-1',
      'deployment',
      {
        limit: undefined,
        scope: undefined,
        reader: { userId: 'user-1', tokenId: null, sessionId: null },
      },
    );
  });

  function withWorkspace(knowledgeService: KnowledgeService) {
    const controller = new KnowledgeController(
      knowledgeService,
      {} as PrismaService,
      {} as KnowledgeOverviewService,
      {} as LooseFactsService,
    );
    jest
      .spyOn(
        controller as unknown as { workspace: () => Promise<string> },
        'workspace',
      )
      .mockResolvedValue('workspace-1');
    return controller;
  }

  it('[KG-3.1] tells the search who is reading: the user, the token and the harness session', async () => {
    const knowledgeService = {
      search: jest.fn().mockResolvedValue({ hits: [] }),
      contextPack: jest.fn().mockResolvedValue({ items: [] }),
    } as unknown as KnowledgeService;
    const controller = withWorkspace(knowledgeService);

    await controller.search(
      'session-workspace',
      'agent-1',
      'token-9',
      'claude-session-42',
      { query: 'deployment' } as KnowledgeSearchQueryDto,
    );
    await controller.contextPack(
      'session-workspace',
      'agent-1',
      'token-9',
      'claude-session-42',
      // A reader sent in the body is not believed; the request says who it is.
      { scope: 'apps/server', reader: { userId: 'someone-else' } } as never,
    );

    const reader = {
      userId: 'agent-1',
      tokenId: 'token-9',
      sessionId: 'claude-session-42',
    };
    expect(knowledgeService.search).toHaveBeenCalledWith(
      'workspace-1',
      'deployment',
      expect.objectContaining({ reader }),
    );
    expect(knowledgeService.contextPack).toHaveBeenCalledWith(
      'workspace-1',
      expect.objectContaining({ scope: 'apps/server', reader }),
    );
  });

  it('[KG-3.1] keeps a session id only when it is one: printable, and not too long', () => {
    expect(harnessSessionOf(' abc-123 ')).toBe('abc-123');
    expect(harnessSessionOf(['first', 'second'])).toBe('first');
    expect(harnessSessionOf(undefined)).toBeNull();
    expect(harnessSessionOf('')).toBeNull();
    expect(harnessSessionOf('has a space')).toBeNull();
    expect(harnessSessionOf('line\nbreak')).toBeNull();
    expect(harnessSessionOf('x'.repeat(201))).toBeNull();
    expect(harnessSessionOf('x'.repeat(200))).toBe('x'.repeat(200));
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
      {} as KnowledgeOverviewService,
      {} as LooseFactsService,
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

    await controller.search(
      'session-workspace',
      'user-1',
      null,
      undefined,
      query,
    );

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

  it('[KG-7.1] hands the entries a page cites to the list, and refuses an id that is not one', async () => {
    const pageEntriesService = {
      getEntries: jest.fn().mockResolvedValue([]),
    } as unknown as PageEntriesService;
    const prisma = {
      usersOnWorkspaces: {
        findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }),
      },
    } as unknown as PrismaService;
    const controller = new PageEntriesController(pageEntriesService, prisma);
    const ids = [
      '33333333-3333-4333-8333-000000000001',
      '33333333-3333-4333-8333-000000000002',
    ];

    // As a generated page's reader sends it: the ids, and in use only.
    const query = plainToInstance(ListPageEntriesQueryDto, {
      ids: ids.join(','),
      status: 'STANDING,CONSOLIDATED',
    });
    await expect(validate(query)).resolves.toEqual([]);
    await controller.getEntries('workspace-1', 'user-1', query);

    expect(pageEntriesService.getEntries).toHaveBeenCalledWith(
      'workspace-1',
      expect.objectContaining({
        ids,
        status: ['STANDING', 'CONSOLIDATED'],
      }),
    );

    const bad = plainToInstance(ListPageEntriesQueryDto, {
      ids: `${ids[0]},page-1`,
    });
    await expect(validate(bad)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ property: 'ids' })]),
    );
  });
});

import type KnowledgeService from './knowledge.service';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from 'nestjs-prisma';

import { KnowledgeController } from './knowledge.controller';
import { KnowledgeSearchQueryDto } from '../../../../../packages/types/src/page/knowledge.dto';

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

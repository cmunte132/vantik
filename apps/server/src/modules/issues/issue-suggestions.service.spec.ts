/**
 * What the suggestion run writes, and what it refuses to write.
 *
 * The rule the whole design rests on: a suggestion lands on `IssueSuggestion`
 * and never on `Issue.moduleIds`. A fast model choosing from forty modules on
 * two sentences is confidently wrong often enough that writing straight to the
 * issue would fill every module-grouped board with plausible noise.
 *
 * Accepting is the human act that promotes a module to the top tier. Dismissing
 * writes nothing to the issue and is remembered.
 */
import { PrismaService } from 'nestjs-prisma';

import AIRequestsService from 'modules/ai-requests/ai-requests.services';
import IssueRelationService from 'modules/issue-relation/issue-relation.service';
import { VectorService } from 'modules/vector/vector.service';

import IssuesAIService from './issues-ai.service';
import { IssueWithRelations } from './issues.interface';

const WORKSPACE = 'workspace-1';

const issue = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'issue-1',
    teamId: 'team-1',
    labelIds: [],
    moduleIds: [],
    description: null,
    team: { workspaceId: WORKSPACE },
    ...overrides,
  }) as unknown as IssueWithRelations;

function buildService(
  options: {
    suggestion?: { suggestedModuleIds: string[]; metadata: unknown } | null;
    issueRow?: { id: string; moduleIds: string[] } | null;
  } = {},
) {
  const getLLMRequest = jest.fn().mockResolvedValue('Server');

  const prisma = {
    label: { findMany: jest.fn().mockResolvedValue([]) },
    issueRelation: { findMany: jest.fn().mockResolvedValue([]) },
    module: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'module-server', name: 'Server', description: 'The API' },
        ]),
    },
    prompt: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ prompt: 'classify', model: 'fast' }),
    },
    issue: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          options.issueRow === undefined
            ? { id: 'issue-1', moduleIds: [] }
            : options.issueRow,
        ),
      update: jest.fn().mockResolvedValue({}),
    },
    issueSuggestion: {
      findUnique: jest.fn().mockResolvedValue(options.suggestion ?? null),
      upsert: jest.fn().mockImplementation(({ create, update }) =>
        Promise.resolve({
          suggestedLabelIds: create?.suggestedLabelIds ?? [],
          suggestedModuleIds:
            update?.suggestedModuleIds ?? create?.suggestedModuleIds ?? [],
        }),
      ),
      update: jest.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaService;

  const service = new IssuesAIService(
    prisma,
    {} as unknown as VectorService,
    { getLLMRequest } as unknown as AIRequestsService,
    {} as unknown as IssueRelationService,
  );

  return { service, prisma, getLLMRequest };
}

/**
 * `isLLMConfigured` wants all four, and returns false unless every one is set.
 * Without them the classifier answers nothing, and these tests would pass by
 * never reaching the model at all.
 */
beforeAll(() => {
  process.env.LLM_BASE_URL = 'http://llm.test';
  process.env.LLM_API_KEY = 'test-key';
  process.env.LLM_MODEL_FAST = 'fast-model';
  process.env.LLM_MODEL_SMART = 'smart-model';
});

describe('IssuesAIService.issueSuggestions', () => {
  /**
   * An issue that already has modules is skipped without a model call. A person
   * or a pull request put them there, and neither is improved by a guess.
   */
  it('asks the model nothing when the issue already has modules', async () => {
    const { service, getLLMRequest, prisma } = buildService();

    await service.issueSuggestions(
      issue({ moduleIds: ['module-server'], labelIds: ['label-bug'] }),
    );

    expect(getLLMRequest).not.toHaveBeenCalled();
    expect(prisma.issue.update).not.toHaveBeenCalled();
  });

  /**
   * Labels and modules are guarded on their own. An issue somebody labelled by
   * hand has said nothing about the code it changes, so it still gets a module
   * suggested.
   */
  it('still suggests modules for an issue that has labels', async () => {
    const { service, getLLMRequest, prisma } = buildService();

    await service.issueSuggestions(
      issue({ labelIds: ['label-bug'], description: 'Fix the API' }),
    );

    expect(getLLMRequest).toHaveBeenCalled();
    expect(
      (prisma.issueSuggestion.upsert as jest.Mock).mock.calls[0][0].update,
    ).toMatchObject({ suggestedModuleIds: ['module-server'] });
  });

  /** The whole design: a suggestion never reaches the issue. */
  it('never writes the suggested module to the issue', async () => {
    const { service, prisma } = buildService();

    await service.issueSuggestions(issue({ description: 'Fix the API' }));

    expect(prisma.issue.update).not.toHaveBeenCalled();
  });

  it('writes the suggestion to IssueSuggestion', async () => {
    const { service, prisma } = buildService();

    await service.issueSuggestions(issue({ description: 'Fix the API' }));

    const upsert = (prisma.issueSuggestion.upsert as jest.Mock).mock
      .calls[0][0];
    expect(upsert.create.suggestedModuleIds).toEqual(['module-server']);
  });

  /**
   * The classifier has no memory and names the same module every run, so the
   * chip a person closed would come back without this.
   */
  it('leaves out a module that a person dismissed', async () => {
    const { service, prisma } = buildService({
      suggestion: {
        suggestedModuleIds: [],
        metadata: { dismissedModuleIds: ['module-server'] },
      },
    });

    await service.issueSuggestions(issue({ description: 'Fix the API' }));

    const upsert = (prisma.issueSuggestion.upsert as jest.Mock).mock
      .calls[0][0];
    expect(upsert.create.suggestedModuleIds).toEqual([]);
  });
});

describe('IssuesAIService.acceptModuleSuggestion', () => {
  it('writes the module onto the issue', async () => {
    const { service, prisma } = buildService({
      suggestion: { suggestedModuleIds: ['module-server'], metadata: null },
    });

    await service.acceptModuleSuggestion('issue-1', 'module-server');

    expect((prisma.issue.update as jest.Mock).mock.calls[0][0].data).toEqual({
      moduleIds: ['module-server'],
    });
  });

  it('keeps the modules the issue already had', async () => {
    const { service, prisma } = buildService({
      issueRow: { id: 'issue-1', moduleIds: ['module-chosen'] },
      suggestion: { suggestedModuleIds: ['module-server'], metadata: null },
    });

    await service.acceptModuleSuggestion('issue-1', 'module-server');

    expect((prisma.issue.update as jest.Mock).mock.calls[0][0].data).toEqual({
      moduleIds: ['module-chosen', 'module-server'],
    });
  });

  /** It is no longer a suggestion once it is on the issue. */
  it('takes the module out of the suggestion', async () => {
    const { service, prisma } = buildService({
      suggestion: {
        suggestedModuleIds: ['module-server', 'module-webapp'],
        metadata: null,
      },
    });

    await service.acceptModuleSuggestion('issue-1', 'module-server');

    expect(
      (prisma.issueSuggestion.update as jest.Mock).mock.calls[0][0].data,
    ).toEqual({ suggestedModuleIds: ['module-webapp'] });
  });

  it('writes nothing for an issue that does not exist', async () => {
    const { service, prisma } = buildService({ issueRow: null });

    const result = await service.acceptModuleSuggestion(
      'gone',
      'module-server',
    );

    expect(result).toBeUndefined();
    expect(prisma.issue.update).not.toHaveBeenCalled();
  });
});

describe('IssuesAIService.dismissModuleSuggestion', () => {
  /** Dismissing leaves the issue exactly as it was. */
  it('does not touch the issue', async () => {
    const { service, prisma } = buildService({
      suggestion: { suggestedModuleIds: ['module-server'], metadata: null },
    });

    await service.dismissModuleSuggestion('issue-1', 'module-server');

    expect(prisma.issue.update).not.toHaveBeenCalled();
  });

  it('removes the module from the suggestion and remembers it', async () => {
    const { service, prisma } = buildService({
      suggestion: {
        suggestedModuleIds: ['module-server', 'module-webapp'],
        metadata: null,
      },
    });

    await service.dismissModuleSuggestion('issue-1', 'module-server');

    expect(
      (prisma.issueSuggestion.update as jest.Mock).mock.calls[0][0].data,
    ).toEqual({
      suggestedModuleIds: ['module-webapp'],
      metadata: { dismissedModuleIds: ['module-server'] },
    });
  });

  it('writes nothing when the issue has no suggestion', async () => {
    const { service, prisma } = buildService({ suggestion: null });

    const result = await service.dismissModuleSuggestion(
      'issue-1',
      'module-server',
    );

    expect(result).toBeUndefined();
    expect(prisma.issueSuggestion.update).not.toHaveBeenCalled();
  });
});

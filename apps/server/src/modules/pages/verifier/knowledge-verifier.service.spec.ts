/**
 * The verifier agent, over a fake store, a fake repository and a model that
 * the test plays. No provider is called.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { ModuleRef } from '@nestjs/core';
import { Queue } from 'bull';
import { PrismaService } from 'nestjs-prisma';

import { CredentialsService } from 'modules/agent-runs/credentials/credentials.service';

import EntryCitationsService, {
  type CitationDraft,
} from '../entry-citations.service';
import RepoFileSourceService from '../repo-file-source.service';
import KnowledgeVerifierService, {
  pageExcerpt,
  parseAnswer,
  type VerifierModel,
} from './knowledge-verifier.service';

jest.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: jest.fn(() => ({
    chatModel: jest.fn((id: string) => ({ modelId: id })),
  })),
}));

const WORKSPACE = 'workspace-1';
const SHA = 'a'.repeat(40);
const FILE = [
  "import { Controller, Get } from '@nestjs/common';",
  '',
  "@Controller('health')",
  'export class HealthController {',
  "  @Get('ready')",
  '  ready() {}',
  '}',
].join('\n');

type Row = Record<string, unknown>;

function setup(
  options: {
    preferences?: unknown;
    status?: string;
    verification?: Row | null;
    key?: { provider: string; secret: string; baseUrl: string | null } | null;
    answer?:
      | string
      | ((tools: Parameters<VerifierModel>[0]['tools']) => Promise<string>);
    throws?: Error;
    holds?: boolean;
  } = {},
) {
  const verification: Row | null =
    options.verification === undefined
      ? { id: 'v1', entryId: 'e1', state: 'PENDING' }
      : options.verification;
  const citations: Row[] = [];
  const entry = {
    id: 'e1',
    content: 'Readiness is GET /health/ready.',
    kind: 'FACT',
    scope: 'apps/server',
    status: options.status ?? 'PROPOSED',
    moduleIds: ['m1'],
    page: {
      title: 'Deployment',
      workspaceId: WORKSPACE,
      workspace: { preferences: options.preferences ?? {} },
    },
  };
  const client = {
    knowledgeVerification: {
      findUnique: jest.fn(async () => verification),
      update: jest.fn(async ({ data }: { data: Row }) => {
        Object.assign(verification as Row, data);
        return verification;
      }),
    },
    pageEntry: {
      findFirst: jest.fn(async ({ where }: { where: Row }) =>
        where.status && where.status !== entry.status ? null : entry,
      ),
    },
    pageEntryCitation: {
      createMany: jest.fn(async ({ data }: { data: Row[] }) => {
        citations.push(...data);
        return { count: data.length };
      }),
    },
    workspace: {
      findUnique: jest.fn(async () => ({
        preferences: options.preferences ?? {},
      })),
    },
    moduleRepo: {
      findMany: jest.fn(async () => [
        {
          id: 'r1',
          fullName: 'acme/api',
          externalRepoId: 'x1',
          integrationAccountId: 'ia1',
        },
      ]),
    },
    issue: {
      findMany: jest.fn(async () => [
        { number: 7, title: 'Add readiness', team: { identifier: 'ENG' } },
      ]),
      findFirst: jest.fn(async (): Promise<Row | null> => null),
    },
    $executeRaw: jest.fn(async () => 1),
  };
  const prisma = {
    ...client,
    $transaction: jest.fn(async (work: (tx: typeof client) => unknown) =>
      work(client),
    ),
  };
  const files = {
    head: jest.fn(async () => ({ sha: SHA })),
    read: jest.fn(async () => ({ content: FILE })),
    search: jest.fn(async () => ({
      matches: [{ path: 'src/health.ts', line: 5, text: "@Get('ready')" }],
    })),
  };
  const checkForWrite = jest.fn(
    async (_: string, inputs: Row[]): Promise<CitationDraft[]> => {
      if (!options.holds) {
        throw new Error('citation 1 does not hold');
      }

      return inputs.map(() => ({
        kind: 'CODE',
        moduleRepoId: 'r1',
        path: 'src/health.ts',
        startLine: 3,
        endLine: 5,
        commitSha: SHA,
        snippet: FILE,
        checkedAt: new Date(),
        checkedSha: SHA,
        checkResult: 'HOLDS',
      })) as unknown as CitationDraft[];
    },
  );
  const queue = { add: jest.fn(async () => ({})) };
  const revealModelKey = jest.fn(async () =>
    options.key === undefined
      ? { provider: 'openrouter', secret: 'workspace-secret', baseUrl: null }
      : options.key,
  );
  const moduleRef = {
    get: jest.fn(() => ({ revealModelKey })),
  };
  const asked: Array<Parameters<VerifierModel>[0]> = [];
  const ask: VerifierModel = async (call) => {
    asked.push(call);

    if (options.throws) {
      throw options.throws;
    }

    return {
      text:
        typeof options.answer === 'function'
          ? await options.answer(call.tools)
          : (options.answer ??
            '{"citations": [{"path": "src/health.ts", "lines": "3-5", "quote": "@Controller(\'health\')"}], "outside": false, "reason": "the controller"}'),
    };
  };

  const service = new KnowledgeVerifierService(
    prisma as unknown as PrismaService,
    { checkForWrite } as unknown as EntryCitationsService,
    files as unknown as RepoFileSourceService,
    moduleRef as unknown as ModuleRef,
    undefined,
    queue as unknown as Queue,
  );

  return {
    service,
    withModel: () =>
      KnowledgeVerifierService.using(service, async () => ({
        provider: 'openrouter',
        model: 'google/gemini-3.6-flash',
        ask,
      })),
    verification,
    citations,
    files,
    checkForWrite,
    queue,
    asked,
    revealModelKey,
    moduleRef,
  };
}

describe('the verifier', () => {
  it('[ENG-224] attaches the citations the server finds to hold, and sends the entry back through triage', async () => {
    const t = setup({ holds: true });

    await expect(t.withModel().verify('e1')).resolves.toBe('FOUND');
    expect(t.checkForWrite).toHaveBeenCalledWith(WORKSPACE, [
      { path: 'src/health.ts', lines: '3-5', quote: "@Controller('health')" },
    ]);
    expect(t.citations).toEqual([
      expect.objectContaining({ entryId: 'e1', checkResult: 'HOLDS' }),
    ]);
    expect(t.verification).toMatchObject({
      state: 'FOUND',
      found: 1,
      provider: 'openrouter',
      model: 'google/gemini-3.6-flash',
    });
    expect(t.queue.add).toHaveBeenCalledWith(
      'triageEntry',
      { entryId: 'e1', trigger: 'VERIFIER' },
      expect.objectContaining({
        jobId: expect.stringMatching(/^triageEntry:e1:VERIFIER:/),
      }),
    );
  });

  it('[ENG-224] attaches nothing the server does not find to hold, and leaves the entry to a person', async () => {
    const t = setup({ holds: false });

    await expect(t.withModel().verify('e1')).resolves.toBe('NOTHING');
    expect(t.citations).toEqual([]);
    expect(t.verification).toMatchObject({
      state: 'NOTHING',
      reason: expect.stringContaining('nothing it cited holds'),
    });
    expect(t.queue.add).not.toHaveBeenCalled();
  });

  it('[ENG-224] records a claim about an outside service that it could not confirm', async () => {
    const t = setup({
      answer:
        '{"citations": [], "outside": true, "reason": "a limit of the vendor API"}',
    });

    await expect(t.withModel().verify('e1')).resolves.toBe('NOTHING');
    expect(t.verification).toMatchObject({
      state: 'NOTHING',
      outside: true,
      reason: 'a limit of the vendor API',
    });
  });

  it('[ENG-224] records a look that failed, and why', async () => {
    const t = setup({ throws: new Error('429 rate limited') });

    await expect(t.withModel().verify('e1')).resolves.toBe('FAILED');
    expect(t.verification).toMatchObject({
      state: 'FAILED',
      reason: expect.stringContaining('429 rate limited'),
    });
  });

  it('[ENG-224] looks once, and only at an entry that still waits', async () => {
    const done = setup({
      verification: { id: 'v1', entryId: 'e1', state: 'NOTHING' },
    });

    await expect(done.withModel().verify('e1')).resolves.toBeNull();
    expect(done.asked).toEqual([]);

    const moved = setup({ status: 'STANDING' });

    await expect(moved.withModel().verify('e1')).resolves.toBe('NOTHING');
    expect(moved.asked).toEqual([]);
  });

  it('[ENG-224] gives the model tools that read the code and the issues, and keeps each step', async () => {
    const t = setup({
      holds: true,
      answer: async (tools) => {
        const options = {} as never;
        const search = await tools.search_code.execute?.(
          { query: 'health' },
          options,
        );
        const read = await tools.read_file.execute?.(
          { path: 'src/health.ts', start: 3, end: 5 },
          options,
        );
        const issues = await tools.search_issues.execute?.(
          { query: 'readiness' },
          options,
        );

        expect(search).toBe("acme/api:src/health.ts:5: @Get('ready')");
        expect(read).toBe(
          [
            'acme/api:src/health.ts lines 3-5 of 7',
            "3  @Controller('health')",
            '4  export class HealthController {',
            "5    @Get('ready')",
          ].join('\n'),
        );
        expect(issues).toBe('ENG-7: Add readiness');

        return '{"citations": [{"path": "src/health.ts", "lines": "3-5"}], "outside": false}';
      },
    });

    await expect(t.withModel().verify('e1')).resolves.toBe('FOUND');
    expect(t.files.search).toHaveBeenCalledWith(
      expect.objectContaining({ fullName: 'acme/api' }),
      'health',
      SHA,
    );
    expect(
      (t.verification?.steps as Array<{ tool: string }>).map(
        (step) => step.tool,
      ),
    ).toEqual(['search_code', 'read_file', 'search_issues', 'answer']);
  });
});

describe('the model of the verifier', () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
    (createOpenAICompatible as jest.Mock).mockClear();
  });

  it('[ENG-224] is the model the agent settings chose, called with the key the workspace stored', async () => {
    // A key of the deployment is there, and never used.
    process.env.LLM_API_KEY = 'deployment-key';
    process.env.LLM_BASE_URL = 'https://deployment.example/v1';

    const t = setup({
      holds: true,
      preferences: {
        agentRuns: {
          model: { provider: 'openrouter', model: 'google/gemini-3.6-flash' },
        },
      },
    });

    // The call fails at the fake client, which is enough: it was built.
    await t.service.verify('e1');

    expect(t.moduleRef.get).toHaveBeenCalledWith(CredentialsService, {
      strict: false,
    });
    expect(t.revealModelKey).toHaveBeenCalledWith(WORKSPACE, 'openrouter');
    expect(createOpenAICompatible).toHaveBeenCalledWith({
      name: 'openrouter',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'workspace-secret',
    });
    expect(t.verification).toMatchObject({
      provider: 'openrouter',
      model: 'google/gemini-3.6-flash',
    });
  });

  it('[ENG-224] is none when the agent settings chose no model, and nothing falls back to the deployment', async () => {
    process.env.LLM_API_KEY = 'deployment-key';

    const t = setup();

    await expect(t.service.verify('e1')).resolves.toBe('NO_PROVIDER');
    expect(t.verification).toMatchObject({
      state: 'NO_PROVIDER',
      reason: 'the workspace chose no model in its agent settings',
    });
    expect(t.revealModelKey).not.toHaveBeenCalled();
    expect(createOpenAICompatible).not.toHaveBeenCalled();
  });

  it('[ENG-224] is none when the workspace holds no key for the provider it chose', async () => {
    const t = setup({
      key: null,
      preferences: {
        agentRuns: { model: { provider: 'anthropic', model: 'claude-x' } },
      },
    });

    await expect(t.service.verify('e1')).resolves.toBe('NO_PROVIDER');
    expect(t.verification).toMatchObject({
      reason: 'the workspace holds no key for anthropic in its agent settings',
    });
    expect(createOpenAICompatible).not.toHaveBeenCalled();
  });

  it('[ENG-224] is none for a provider the server cannot call', async () => {
    const t = setup({
      key: {
        provider: 'azure-openai-responses',
        secret: 's',
        baseUrl: 'https://r.openai.azure.com',
      },
      preferences: {
        agentRuns: {
          model: { provider: 'azure-openai-responses', model: 'gpt' },
        },
      },
    });

    await expect(t.service.verify('e1')).resolves.toBe('NO_PROVIDER');
    expect(createOpenAICompatible).not.toHaveBeenCalled();
  });
});

describe('reading the answer of the verifier', () => {
  it('[ENG-224] keeps only citations of the shapes a writer can give', () => {
    expect(
      parseAnswer(
        'Done. {"citations": [{"issue": "ENG-4"}, {"path": "a.ts"}, {"path": "b.ts", "lines": "2", "repo": "acme/api"}, 7], "outside": "yes"}',
      ),
    ).toEqual({
      citations: [
        { issue: 'ENG-4' },
        { path: 'b.ts', lines: '2', repo: 'acme/api' },
      ],
      outside: false,
      reason: null,
    });
    expect(parseAnswer('no json here')).toBeNull();
  });
});

describe('a page the verifier reads', () => {
  it('[ENG-224] keeps a page citation only with a quote long enough to check', () => {
    expect(
      parseAnswer(
        JSON.stringify({
          citations: [
            {
              url: 'https://docs.vendor.example/limits',
              quote: 'Each key can make 100 requests per second.',
            },
            { url: 'https://docs.vendor.example/other', quote: 'too short' },
            { url: 'https://docs.vendor.example/none' },
          ],
          outside: true,
          reason: 'The vendor documents the limit.',
        }),
      ),
    ).toEqual({
      citations: [
        {
          url: 'https://docs.vendor.example/limits',
          quote: 'Each key can make 100 requests per second.',
        },
      ],
      outside: true,
      reason: 'The vendor documents the limit.',
    });
  });

  it('[ENG-224] returns the text around the words it asks for, or the start of the page', () => {
    const page = `${'a'.repeat(1000)} rate limit is 100 ${'b'.repeat(1000)}`;

    const found = pageExcerpt(page, 'RATE   limit');
    expect(found).toContain('rate limit is 100');
    expect(found.length).toBeLessThan(900);

    expect(pageExcerpt(page, 'quota')).toMatch(
      /^The words are not on the page\. It starts:/,
    );
    expect(pageExcerpt('short page')).toBe('short page');
  });
});

import { PrismaService } from 'nestjs-prisma';
import { Client as TypesenseClient } from 'typesense';

import { IssueWithRelations } from 'modules/issues/issues.interface';

import { VectorService } from './vector.service';

const tiptap = (text: string) =>
  JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const issue: any = {
  id: 'issue-1',
  number: 42,
  teamId: 'team-1',
  title: 'Connections exhausted under load',
  description: tiptap('Nightly job saturates the pool'),
  stateId: 'state-done',
  assigneeId: 'user-1',
  team: { identifier: 'ENG', workspaceId: 'workspace-1' },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const comments: any[] = [
  {
    body: tiptap('Anyone seen this before?'),
    createdAt: new Date('2026-01-01T10:00:00Z'),
    parentId: null,
  },
  {
    body: tiptap('Fixed by bumping the pg pool size'),
    createdAt: new Date('2026-01-02T10:00:00Z'),
    parentId: null,
  },
  {
    body: tiptap('Posted after the issue was closed'),
    createdAt: new Date('2026-01-04T10:00:00Z'),
    parentId: null,
  },
];

function buildDeps(overrides: { comments?: unknown[]; completedAt?: Date }) {
  const upsert = jest.fn().mockResolvedValue({});

  const prisma = {
    workflow: {
      findUnique: jest.fn().mockResolvedValue({ category: 'COMPLETED' }),
      findMany: jest.fn().mockResolvedValue([{ id: 'state-done' }]),
    },
    issueComment: {
      findMany: jest.fn().mockResolvedValue(overrides.comments ?? comments),
    },
    issueHistory: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          overrides.completedAt === undefined
            ? { createdAt: new Date('2026-01-03T10:00:00Z') }
            : { createdAt: overrides.completedAt },
        ),
    },
  } as unknown as PrismaService;

  const typesense = {
    collections: jest.fn(() => ({ documents: () => ({ upsert }) })),
  } as unknown as TypesenseClient;

  return { prisma, typesense, upsert };
}

describe('VectorService', () => {
  // These tests exercise the typesense-only path; a developer with Cohere
  // configured must not end up making real embedding calls.
  const cohereKey = process.env.COHERE_API_KEY;
  beforeAll(() => {
    delete process.env.COHERE_API_KEY;
  });
  afterAll(() => {
    if (cohereKey) {
      process.env.COHERE_API_KEY = cohereKey;
    }
  });

  describe('createIssueEmbedding', () => {
    it('indexes the state category and every comment body', async () => {
      const { prisma, typesense, upsert } = buildDeps({});

      await new VectorService(prisma, typesense).createIssueEmbedding(
        issue as IssueWithRelations,
      );

      const document = upsert.mock.calls[0][0];
      expect(document.stateCategory).toBe('COMPLETED');
      expect(document.commentsText).toContain('Anyone seen this before?');
      expect(document.commentsText).toContain('bumping the pg pool size');
    });

    it('picks the last top level comment before the issue was completed', async () => {
      const { prisma, typesense, upsert } = buildDeps({});

      await new VectorService(prisma, typesense).createIssueEmbedding(
        issue as IssueWithRelations,
      );

      // The 2026-01-04 comment lands after the 2026-01-03 transition, so the
      // resolution is the one immediately before it.
      expect(upsert.mock.calls[0][0].resolutionText).toBe(
        'Fixed by bumping the pg pool size',
      );
    });

    it('leaves the resolution empty when the issue never completed', async () => {
      const { prisma, typesense, upsert } = buildDeps({ completedAt: null });

      await new VectorService(prisma, typesense).createIssueEmbedding(
        issue as IssueWithRelations,
      );

      expect(upsert.mock.calls[0][0].resolutionText).toBe('');
    });

    it('handles issues with no comments', async () => {
      const { prisma, typesense, upsert } = buildDeps({ comments: [] });

      await new VectorService(prisma, typesense).createIssueEmbedding(
        issue as IssueWithRelations,
      );

      expect(upsert.mock.calls[0][0].commentsText).toBe('');
      expect(upsert.mock.calls[0][0].resolutionText).toBe('');
    });
  });

  describe('searchEmbeddings', () => {
    function buildSearchDeps() {
      const perform = jest.fn().mockResolvedValue({
        results: [
          {
            hits: [
              {
                document: {
                  id: 'issue-1',
                  title: 'Connections exhausted under load',
                  description: '',
                  descriptionString: '',
                  stateId: 'state-done',
                  stateCategory: 'COMPLETED',
                  resolutionText: 'Fixed by bumping the pg pool size',
                  teamId: 'team-1',
                  number: 42,
                  issueNumber: 'ENG-42',
                  workspaceId: 'workspace-1',
                  assigneeId: 'user-1',
                },
                vector_distance: 0.2,
              },
            ],
          },
        ],
      });

      return {
        prisma: {} as PrismaService,
        typesense: {
          multiSearch: { perform },
        } as unknown as TypesenseClient,
        perform,
      };
    }

    it('filters by workspace only when no categories are given', async () => {
      const { prisma, typesense, perform } = buildSearchDeps();

      await new VectorService(prisma, typesense).searchEmbeddings(
        'workspace-1',
        'pg pool',
        10,
      );

      expect(perform.mock.calls[0][0].searches[0].filter_by).toBe(
        'workspaceId:=workspace-1',
      );
    });

    it('restricts to the requested state categories', async () => {
      const { prisma, typesense, perform } = buildSearchDeps();

      await new VectorService(prisma, typesense).searchEmbeddings(
        'workspace-1',
        'pg pool',
        10,
        0.8,
        ['COMPLETED', 'CANCELED'],
      );

      expect(perform.mock.calls[0][0].searches[0].filter_by).toBe(
        'workspaceId:=workspace-1 && stateCategory:=[COMPLETED,CANCELED]',
      );
    });

    it('returns the state category and a resolution snippet on each hit', async () => {
      const { prisma, typesense } = buildSearchDeps();

      const hits = await new VectorService(prisma, typesense).searchEmbeddings(
        'workspace-1',
        'pg pool',
        10,
      );

      expect(hits[0]).toMatchObject({
        id: 'issue-1',
        stateCategory: 'COMPLETED',
        resolutionSnippet: 'Fixed by bumping the pg pool size',
      });
    });
  });
});

describe('VectorService.createIssuesCollection', () => {
  const liveFields = [
    'teamId',
    'number',
    'numberString',
    'issueNumber',
    'title',
    'description',
    'descriptionString',
    'stateId',
    'stateCategory',
    'commentsText',
    'resolutionText',
    'workspaceId',
    'assigneeId',
    'embeddings',
  ].map((name) => ({ name }));

  function buildCollectionDeps(fields: Array<{ name: string }>) {
    const remove = jest.fn().mockResolvedValue({});
    const create = jest.fn().mockResolvedValue({});
    const typesense = {
      collections: jest.fn((name?: string) =>
        name
          ? { retrieve: () => Promise.resolve({ fields }), delete: remove }
          : { create },
      ),
    } as unknown as TypesenseClient;

    const prisma = {
      workspace: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;

    return { prisma, typesense, remove, create };
  }

  it('leaves an up to date collection alone', async () => {
    const { prisma, typesense, remove, create } =
      buildCollectionDeps(liveFields);

    await new VectorService(prisma, typesense).createIssuesCollection();

    expect(remove).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('rebuilds a collection created before the new fields existed', async () => {
    const { prisma, typesense, remove, create } = buildCollectionDeps(
      liveFields.filter(
        (field) =>
          !['stateCategory', 'commentsText', 'resolutionText'].includes(
            field.name,
          ),
      ),
    );

    await new VectorService(prisma, typesense).createIssuesCollection();

    expect(remove).toHaveBeenCalled();
    expect(create).toHaveBeenCalled();
  });
});

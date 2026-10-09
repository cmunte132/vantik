/**
 * `GET /v1/search/similar_issues` declared a `limit` and dropped it: the vector
 * search always asked for 10 hits. The limit is read like the one on `/search`,
 * with the same default and cap.
 */
import { PrismaService } from 'nestjs-prisma';

import { EmbeddingsService } from 'modules/vector/embeddings.service';
import { VectorService } from 'modules/vector/vector.service';

import { SearchController } from './search.controller';
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  SimilarIssueData,
} from './search.interface';
import SearchService from './search.service';

function controller() {
  const similarData = jest.fn().mockResolvedValue([]);
  const service = { similarData } as unknown as SearchService;

  return { controller: new SearchController(service), similarData };
}

async function ask(query: Partial<SimilarIssueData>) {
  const { controller: c, similarData } = controller();

  await c.similarIssue(
    'ws-1',
    'user-1',
    Object.assign(new SimilarIssueData(), { issueId: 'issue-1', ...query }),
  );

  return similarData.mock.calls[0][4];
}

describe('GET similar_issues limit', () => {
  it('passes the limit the caller named', async () => {
    expect(await ask({ limit: '3' })).toBe(3);
  });

  it('caps the limit', async () => {
    expect(await ask({ limit: '100000' })).toBe(MAX_SEARCH_LIMIT);
  });

  it('uses the default when none is named', async () => {
    expect(await ask({})).toBe(DEFAULT_SEARCH_LIMIT);
  });
});

const WORKSPACE = '11111111-1111-4111-8111-111111111111';

describe('VectorService.similarIssues limit', () => {
  function vector() {
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ title: 'T', embeddingText: 'T', vector: null }]),
    } as unknown as PrismaService;
    const embeddings = {
      configuredModel: (): string | null => null,
    } as unknown as EmbeddingsService;
    const service = new VectorService(prisma, embeddings);
    const issueSearch = jest
      .spyOn(service as never, 'issueSearch')
      .mockResolvedValue([] as never);

    return { service, issueSearch };
  }

  it('searches for as many hits as the limit says', async () => {
    const { service, issueSearch } = vector();

    await service.similarIssues(WORKSPACE, 'issue-1', undefined, 4);

    expect((issueSearch.mock.calls[0] as unknown[])[2]).toBe(4);
  });

  it('searches for 10 hits when no limit is given', async () => {
    const { service, issueSearch } = vector();

    await service.similarIssues(WORKSPACE, 'issue-1');

    expect((issueSearch.mock.calls[0] as unknown[])[2]).toBe(10);
  });
});

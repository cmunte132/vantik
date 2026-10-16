/**
 * `updateIssueApi` ignored `descriptionMarkdown: ''`, so a request that
 * cleared a description answered "updated" and left the old text in place.
 */
import { PrismaService } from 'nestjs-prisma';

import IssuesService from './issues.service';

function buildService() {
  const update = jest.fn().mockImplementation(({ data }) =>
    Promise.resolve({
      id: 'issue-1',
      teamId: 'team-1',
      stateId: 's1',
      team: { workspaceId: 'workspace-1' },
      ...data,
    }),
  );
  const prisma = {
    issue: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'issue-1',
        teamId: 'team-1',
        stateId: 's1',
        subscriberIds: [],
        description: '{"type":"doc","content":[]}',
      }),
      update,
    },
    workflow: {
      findUnique: jest.fn().mockResolvedValue({ category: 'STARTED' }),
    },
    cycleHistory: { createMany: jest.fn() },
  } as unknown as PrismaService;
  const history = { upsertIssueHistory: jest.fn() };
  const notifications = { deliver: jest.fn() };
  const service = new IssuesService(
    prisma,
    history as never,
    null,
    notifications as never,
    null,
    null,
    null,
    null,
    { record: jest.fn().mockResolvedValue(undefined) } as never,
  );

  return { service, update };
}

describe('IssuesService.updateIssueApi description', () => {
  const update = (service: IssuesService, data: object) =>
    service.updateIssueApi(
      { teamId: 'team-1' },
      data as never,
      { issueId: 'issue-1' },
      'user-1',
    );

  it('clears the description when the markdown is empty', async () => {
    const { service, update: write } = buildService();

    await update(service, { descriptionMarkdown: '' });

    expect(write.mock.calls[0][0].data).toMatchObject({ description: null });
  });

  it('leaves the description alone when the request does not name it', async () => {
    const { service, update: write } = buildService();

    await update(service, { title: 'New title' });

    expect(write.mock.calls[0][0].data).not.toHaveProperty('description');
  });

  it('writes the text when the markdown has some', async () => {
    const { service, update: write } = buildService();

    await update(service, { descriptionMarkdown: 'Some text' });

    expect(typeof write.mock.calls[0][0].data.description).toBe('string');
  });
});

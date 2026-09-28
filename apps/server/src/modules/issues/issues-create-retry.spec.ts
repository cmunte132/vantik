/**
 * Filing an issue when its team's numbering conflicts.
 *
 * The number is read and written in a serializable transaction, so issues
 * filed into one team at once conflict (Prisma's P2034) and are tried again.
 * When every try conflicted, the service fell out of its loop and returned
 * nothing: the route answered 201 with an empty body, and no issue existed.
 */
import { ConflictException } from '@nestjs/common';
import { CreateIssueDto } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import IssuesService, { CREATE_ISSUE_ATTEMPTS } from './issues.service';

jest.mock('./issues.utils', () => ({
  ...jest.requireActual('./issues.utils'),
  getIssueDiff: jest.fn(async () => ({})),
  handlePostCreateIssue: jest.fn(),
}));

const conflict = () =>
  Object.assign(new Error('write conflict'), { code: 'P2034' });

const ISSUE = {
  id: 'issue-1',
  title: 'Filed at a busy moment',
  description: null as string | null,
  team: { workspaceId: 'workspace-1' },
};

function buildService(transaction: jest.Mock) {
  const prisma = {
    team: {
      findUnique: jest.fn(async () => ({ workspace: { id: 'workspace-1' } })),
    },
    $transaction: transaction,
  } as unknown as PrismaService;

  const service = new IssuesService(
    prisma,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  );
  jest
    .spyOn(
      service as unknown as { upsertIssueHistory: () => void },
      'upsertIssueHistory',
    )
    .mockImplementation(() => undefined);

  return service;
}

const DATA = {
  title: 'Filed at a busy moment',
  teamId: 'team-1',
} as CreateIssueDto;

describe('IssuesService.createIssueAPI under conflicting writes', () => {
  it('says so when every try conflicts, rather than answering with nothing', async () => {
    const transaction = jest.fn().mockRejectedValue(conflict());
    const service = buildService(transaction);

    await expect(service.createIssueAPI(DATA, 'user-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(transaction).toHaveBeenCalledTimes(CREATE_ISSUE_ATTEMPTS);
  });

  it('files the issue on a later try', async () => {
    const transaction = jest
      .fn()
      .mockRejectedValueOnce(conflict())
      .mockRejectedValueOnce(conflict())
      .mockResolvedValue([ISSUE]);
    const service = buildService(transaction);

    await expect(service.createIssueAPI(DATA, 'user-1')).resolves.toMatchObject(
      {
        id: ISSUE.id,
      },
    );
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('does not retry any other failure', async () => {
    const failure = new Error('connection lost');
    const transaction = jest.fn().mockRejectedValue(failure);
    const service = buildService(transaction);

    await expect(service.createIssueAPI(DATA, 'user-1')).rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});

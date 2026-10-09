/**
 * `GET /v1/issues/number/:issueNumber?teamId=` read `description` off the
 * result of a `findFirst`, which is null for a number the team has not used, so
 * an unknown number answered 500 instead of 404.
 */
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from 'nestjs-prisma';

import IssuesService from './issues.service';

function buildService(found: unknown) {
  const findFirst = jest.fn().mockResolvedValue(found);
  const prisma = { issue: { findFirst } } as unknown as PrismaService;
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

  return { service, findFirst };
}

describe('IssuesService.getIssueByNumber', () => {
  it('answers 404 for a number the team has not used', async () => {
    const { service } = buildService(null);

    await expect(
      service.getIssueByNumber('9999', 'team-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers 404 for a number that is not a number, without a query', async () => {
    const { service, findFirst } = buildService(null);

    await expect(
      service.getIssueByNumber('abc', 'team-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('returns the issue, scoped to the team and not deleted', async () => {
    const { service, findFirst } = buildService({
      id: 'issue-1',
      number: 7,
      description: null,
    });

    const issue = await service.getIssueByNumber('7', 'team-1');

    expect(issue.id).toBe('issue-1');
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { number: 7, teamId: 'team-1', deleted: null },
      }),
    );
  });
});

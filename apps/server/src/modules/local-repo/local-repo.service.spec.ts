import { ForbiddenException } from '@nestjs/common';
import { setRepositoryGitIssues } from 'integrations/local-repo/repositories';

import { resolveAdminWorkspaceId } from 'common/workspace-access';

import { LocalRepoService } from './local-repo.service';

jest.mock('common/workspace-access', () => ({
  resolveAdminWorkspaceId: jest.fn(),
}));
jest.mock('integrations/local-repo/repositories', () => ({
  ...jest.requireActual('integrations/local-repo/repositories'),
  setRepositoryGitIssues: jest.fn().mockResolvedValue({ id: 'repo-1' }),
}));

describe('LocalRepoService.setGitIssues', () => {
  const admin = resolveAdminWorkspaceId as jest.Mock;
  const write = setRepositoryGitIssues as jest.Mock;
  const service = new LocalRepoService(
    {} as never,
    { build: jest.fn().mockReturnValue({}) } as never,
  );

  beforeEach(() => {
    admin.mockReset();
    write.mockClear();
  });

  it('writes for an admin of the workspace, in the workspace that the check named', async () => {
    admin.mockResolvedValue('workspace-2');

    await service.setGitIssues('workspace-1', 'user-1', 'repo-1', ['team-a']);

    expect(write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceId: 'workspace-2',
        repositoryId: 'repo-1',
        teamIds: ['team-a'],
      }),
    );
  });

  it('writes nothing for a member who is not an admin', async () => {
    admin.mockRejectedValue(new ForbiddenException());

    await expect(
      service.setGitIssues('workspace-1', 'user-1', 'repo-1', ['team-a']),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(write).not.toHaveBeenCalled();
  });
});

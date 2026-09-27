/**
 * What a member may change about a workspace through the general update
 * route, which any member or write-scoped agent token can call.
 */
import WorkspacesService from './workspaces.service';

jest.mock('supertokens-node/recipe/session', () => ({
  __esModule: true,
  default: {},
}));

describe('updating a workspace', () => {
  it('[KG-4.5] changes its name and icon, and never its preferences', async () => {
    const update = jest.fn(async ({ data }) => ({
      id: 'workspace-1',
      ...data,
    }));
    const service = new WorkspacesService(
      { workspace: { update } } as never,
      {} as never,
      {} as never,
    );

    // Undeclared keys survive validation, so the body can carry anything.
    await service.updateWorkspace('workspace-1', {
      name: 'Acme',
      icon: 'rocket',
      preferences: {
        knowledge: { autoTriage: 'on', similarityThreshold: 1 },
      },
    } as never);

    expect(update).toHaveBeenCalledWith({
      data: { name: 'Acme', icon: 'rocket' },
      where: { id: 'workspace-1' },
    });
  });
});

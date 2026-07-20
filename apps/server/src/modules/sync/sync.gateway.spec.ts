import { Socket } from 'socket.io';

import { SyncGateway } from './sync.gateway';
import { getAuthenticatedIdentity } from './sync.utils';

jest.mock('./sync.utils', () => ({
  getAuthenticatedIdentity: jest.fn(),
}));

const mockedIdentity = getAuthenticatedIdentity as jest.MockedFunction<
  typeof getAuthenticatedIdentity
>;

const OWN_WORKSPACE = 'workspace-own';
const FOREIGN_WORKSPACE = 'workspace-foreign';
const USER = 'user-self';
const VICTIM = 'user-victim';

function buildClient(query: Record<string, string>) {
  return {
    id: 'socket-1',
    handshake: { query, headers: { cookie: 'sAccessToken=token' } },
    join: jest.fn(),
    disconnect: jest.fn(),
  } as unknown as Socket & {
    join: jest.Mock;
    disconnect: jest.Mock;
  };
}

function buildGateway(
  memberships: Array<{ userId: string; workspaceId: string }>,
) {
  const prisma = {
    usersOnWorkspaces: {
      findUnique: jest.fn(async ({ where }) => {
        const { userId, workspaceId } = where.userId_workspaceId;
        return memberships.some(
          (m) => m.userId === userId && m.workspaceId === workspaceId,
        )
          ? { status: 'ACTIVE' }
          : null;
      }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return new SyncGateway(prisma);
}

describe('SyncGateway.handleConnection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedIdentity.mockResolvedValue({
      userId: USER,
      workspaceId: OWN_WORKSPACE,
    });
  });

  it('joins the rooms of the caller the token identifies', async () => {
    const gateway = buildGateway([
      { userId: USER, workspaceId: OWN_WORKSPACE },
    ]);
    const client = buildClient({ workspaceId: OWN_WORKSPACE, userId: USER });

    await gateway.handleConnection(client);

    expect(client.join).toHaveBeenCalledWith(OWN_WORKSPACE);
    expect(client.join).toHaveBeenCalledWith(USER);
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('disconnects when the handshake carries no valid session', async () => {
    mockedIdentity.mockResolvedValue(null);
    const gateway = buildGateway([
      { userId: USER, workspaceId: OWN_WORKSPACE },
    ]);
    const client = buildClient({ workspaceId: OWN_WORKSPACE, userId: USER });

    await gateway.handleConnection(client);

    // Regression: the check used to be called without `await`, so the guard
    // never fired and every socket — authenticated or not — joined its rooms.
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('refuses a workspace the caller is not a member of', async () => {
    const gateway = buildGateway([
      { userId: USER, workspaceId: OWN_WORKSPACE },
    ]);
    const client = buildClient({
      workspaceId: FOREIGN_WORKSPACE,
      userId: USER,
    });

    await gateway.handleConnection(client);

    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(client.join).not.toHaveBeenCalled();
  });

  it('ignores a userId named in the query and uses the token subject', async () => {
    const gateway = buildGateway([
      { userId: USER, workspaceId: OWN_WORKSPACE },
    ]);
    const client = buildClient({
      workspaceId: OWN_WORKSPACE,
      userId: VICTIM,
    });

    await gateway.handleConnection(client);

    // Joining the victim's room would deliver their notifications and
    // conversations, which are broadcast to a room named by user id.
    expect(client.join).not.toHaveBeenCalledWith(VICTIM);
    expect(client.join).toHaveBeenCalledWith(USER);
  });

  it('falls back to the session workspace when the query names none', async () => {
    const gateway = buildGateway([
      { userId: USER, workspaceId: OWN_WORKSPACE },
    ]);
    const client = buildClient({ userId: USER });

    await gateway.handleConnection(client);

    expect(client.join).toHaveBeenCalledWith(OWN_WORKSPACE);
    expect(client.disconnect).not.toHaveBeenCalled();
  });
});

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
const TEAM_OWN = 'team-own';
const TEAM_OTHER = 'team-other';

function buildClient(query: Record<string, string>, rooms: string[] = []) {
  return {
    id: 'socket-1',
    handshake: { query, headers: { cookie: 'sAccessToken=token' } },
    join: jest.fn(),
    // The gateway leaves the team rooms that the membership no longer covers,
    // so the fake carries the rooms it is currently in.
    rooms: new Set(rooms),
    leave: jest.fn(),
    // The gateway announces its build to each client that connects, so a fake
    // socket without this throws before the assertions are reached.
    emit: jest.fn(),
    disconnect: jest.fn(),
  } as unknown as Socket & {
    join: jest.Mock;
    leave: jest.Mock;
    emit: jest.Mock;
    disconnect: jest.Mock;
  };
}

function buildGateway(
  memberships: Array<{
    userId: string;
    workspaceId: string;
    teamIds?: string[];
  }>,
) {
  const prisma = {
    usersOnWorkspaces: {
      findUnique: jest.fn(async ({ where }) => {
        const { userId, workspaceId } = where.userId_workspaceId;
        const membership = memberships.find(
          (m) => m.userId === userId && m.workspaceId === workspaceId,
        );

        return membership
          ? { status: 'ACTIVE', teamIds: membership.teamIds ?? [] }
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

/**
 * A team is a visibility boundary (ENG-79).
 *
 * One room held every member of the workspace, so a change to any issue of any
 * team reached all of them. An announcement about a team-owned record now goes
 * to the room of that team, which makes the room membership the enforcement and
 * not a convenience.
 */
describe('SyncGateway team rooms', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedIdentity.mockResolvedValue({
      userId: USER,
      workspaceId: OWN_WORKSPACE,
    });
  });

  it('joins the room of each team the caller belongs to', async () => {
    const gateway = buildGateway([
      { userId: USER, workspaceId: OWN_WORKSPACE, teamIds: [TEAM_OWN] },
    ]);
    const client = buildClient({ userId: USER });

    await gateway.handleConnection(client);

    expect(client.join).toHaveBeenCalledWith(`${OWN_WORKSPACE}:${TEAM_OWN}`);
  });

  it('joins no room of a team the caller does not belong to', async () => {
    const gateway = buildGateway([
      { userId: USER, workspaceId: OWN_WORKSPACE, teamIds: [TEAM_OWN] },
    ]);
    const client = buildClient({ userId: USER });

    await gateway.handleConnection(client);

    // The message for another team's issue is emitted to this room. A socket
    // that never joins it receives nothing about that team.
    expect(client.join).not.toHaveBeenCalledWith(
      `${OWN_WORKSPACE}:${TEAM_OTHER}`,
    );
  });

  it('joins no team room for a member of no team', async () => {
    const gateway = buildGateway([
      { userId: USER, workspaceId: OWN_WORKSPACE, teamIds: [] },
    ]);
    const client = buildClient({ userId: USER });

    await gateway.handleConnection(client);

    const rooms = client.join.mock.calls.map(([room]) => room);

    expect(rooms).toEqual([OWN_WORKSPACE, USER]);
  });
});

/**
 * A membership changes while the browser stays open.
 *
 * Two things have to happen, and neither is optional. The socket has to change
 * rooms, or a person who left a team goes on receiving its work. And the client
 * has to read again from the start, because the records of a team just joined
 * sit below the sequence id the client already holds, so no delta names them.
 */
describe('SyncGateway.refreshTeamRooms', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedIdentity.mockResolvedValue({
      userId: USER,
      workspaceId: OWN_WORKSPACE,
    });
  });

  async function connected(teamIds: string[], rooms: string[] = []) {
    const gateway = buildGateway([
      { userId: USER, workspaceId: OWN_WORKSPACE, teamIds },
    ]);
    const client = buildClient({ userId: USER }, rooms);

    await gateway.handleConnection(client);

    // The gateway finds a socket through the server it is attached to.
    (gateway as unknown as { wss: unknown }).wss = {
      sockets: { sockets: new Map([[client.id, client]]) },
    };

    return { gateway, client };
  }

  it('leaves the room of a team the person no longer belongs to', async () => {
    const { gateway, client } = await connected(
      [],
      [`${OWN_WORKSPACE}:${TEAM_OTHER}`],
    );

    await gateway.refreshTeamRooms(USER, OWN_WORKSPACE);

    expect(client.leave).toHaveBeenCalledWith(`${OWN_WORKSPACE}:${TEAM_OTHER}`);
  });

  it('keeps the workspace room and the user room', async () => {
    const { gateway, client } = await connected([], [OWN_WORKSPACE, USER]);

    await gateway.refreshTeamRooms(USER, OWN_WORKSPACE);

    expect(client.leave).not.toHaveBeenCalledWith(OWN_WORKSPACE);
    expect(client.leave).not.toHaveBeenCalledWith(USER);
  });

  it('asks the client to read again from the start', async () => {
    const { gateway, client } = await connected([TEAM_OWN]);

    client.emit.mockClear();
    await gateway.refreshTeamRooms(USER, OWN_WORKSPACE);

    expect(client.emit).toHaveBeenCalledWith('resync', {
      reason: 'team-membership-changed',
    });
  });

  it('says nothing to the sockets of another person', async () => {
    const { gateway, client } = await connected([TEAM_OWN]);

    client.emit.mockClear();
    await gateway.refreshTeamRooms(VICTIM, OWN_WORKSPACE);

    expect(client.emit).not.toHaveBeenCalled();
  });

  it('forgets a socket that disconnected', async () => {
    const { gateway, client } = await connected([TEAM_OWN]);

    gateway.handleDisconnect(client);
    client.emit.mockClear();
    await gateway.refreshTeamRooms(USER, OWN_WORKSPACE);

    expect(client.emit).not.toHaveBeenCalled();
  });
});

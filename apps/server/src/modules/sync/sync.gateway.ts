import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { PrismaService } from 'nestjs-prisma';
import { Server, Socket } from 'socket.io';

import { SERVER_BUILD } from 'common/build-stamp';
import { teamRoom, visibleTeamIds } from 'common/team-access';
import { resolveWorkspaceId } from 'common/workspace-access';

import { LoggerService } from 'modules/logger/logger.service';

import { ClientMetadata } from './sync.interface';
import { getAuthenticatedIdentity } from './sync.utils';

@WebSocketGateway({
  cors: {
    // Evaluated at import time, so an unset FRONTEND_HOST used to throw before
    // the module could load at all.
    origin: process.env.FRONTEND_HOST?.split(',') || '',
    credentials: true,
  },
})
export class SyncGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() wss: Server;

  constructor(private prisma: PrismaService) {}

  private readonly clientsMetadata: Record<string, ClientMetadata> = {};
  private readonly logger: LoggerService = new LoggerService('SyncGateway');

  afterInit() {
    this.logger.info({
      message: 'Websocket Module initiated',
      where: `SyncGateway.afterInit`,
    });
  }

  async handleConnection(client: Socket) {
    this.logger.info({
      message: `Connection is made by ${client.id}`,
      where: `SyncGateway.handleConnection`,
    });

    const { query, headers } = client.handshake;

    // The identity comes from the handshake's own access token. The rooms used
    // to be named by `query.workspaceId` and `query.userId`, which let a caller
    // subscribe to any workspace's sync stream and to any user's notifications
    // and conversations. Nothing in the query is trusted here.
    const identity = await getAuthenticatedIdentity(headers);

    if (!identity) {
      this.disconnect(client, 'handshake carried no valid session');
      return;
    }

    // A user may belong to several workspaces, so the handshake still names the
    // one it wants — it is honoured only after membership is proven.
    let workspaceId: string;
    try {
      workspaceId = await resolveWorkspaceId(
        this.prisma,
        identity.userId,
        identity.workspaceId,
        query.workspaceId as string,
      );
    } catch {
      this.disconnect(
        client,
        `no access to workspace ${query.workspaceId ?? '(none named)'}`,
      );
      return;
    }

    this.clientsMetadata[client.id] = { workspaceId, userId: identity.userId };

    client.join(workspaceId);
    client.join(identity.userId);

    // A team is a visibility boundary (ENG-79). The workspace room carries only
    // the records that no team owns; an announcement about an issue goes to the
    // room of its team, so a client hears about a team only when it joins that
    // team's room. Before this, one room held every member of the workspace and
    // every issue of every team went to all of them.
    await this.joinTeamRooms(client, identity.userId, workspaceId);

    // A client that connects to a restarted server learns the build immediately.
    // Combined with the fact that a client reconnects after a deploy anyway,
    // this is what closes the gap for an installed PWA window that has been open
    // for days: it hears about the new build in seconds rather than on its next
    // poll. The client treats it as a prompt to re-check /api/version, not as an
    // answer — this is the server image's stamp, not the webapp's.
    client.emit('server-version', { build: SERVER_BUILD });
  }

  /**
   * This method puts one socket in the room of each team the user belongs to.
   *
   * It leaves every other team room first. That matters on the second call: a
   * person who leaves a team keeps an open socket, and a room that nobody
   * removes them from carries on delivering that team's work.
   */
  private async joinTeamRooms(
    client: Socket,
    userId: string,
    workspaceId: string,
  ) {
    const teamIds = await visibleTeamIds(this.prisma, userId, workspaceId);
    const wanted = new Set(teamIds.map((id) => teamRoom(workspaceId, id)));

    for (const room of client.rooms) {
      if (room.startsWith(`${workspaceId}:`) && !wanted.has(room)) {
        client.leave(room);
      }
    }

    for (const room of wanted) {
      client.join(room);
    }
  }

  /**
   * This method makes every socket of one user follow a change of team.
   *
   * A person joins or leaves a team while the browser is open. The rooms have
   * to change with the membership, and the client has to read again from the
   * start: the records of a team the person just joined sit below the sequence
   * id the client already holds, so no delta will ever carry them.
   *
   * `TeamsService` calls this after it writes the membership.
   */
  async refreshTeamRooms(userId: string, workspaceId: string) {
    for (const [socketId, metadata] of Object.entries(this.clientsMetadata)) {
      if (metadata.userId !== userId || metadata.workspaceId !== workspaceId) {
        continue;
      }

      const socket = this.wss?.sockets?.sockets?.get(socketId);

      if (!socket) {
        continue;
      }

      await this.joinTeamRooms(socket, userId, workspaceId);

      // The client answers this by dropping its store and asking for a
      // bootstrap. It is the same message the server sends when it finds a
      // client ahead of it, so the webapp already knows how to act on it.
      socket.emit('resync', { reason: 'team-membership-changed' });
    }
  }

  /**
   * This method forgets a socket that went away.
   *
   * `refreshTeamRooms` walks `clientsMetadata` to find the sockets of one
   * person, so an entry that no socket answers to is work on every membership
   * change, and the map grew for the life of the process.
   */
  handleDisconnect(client: Socket) {
    delete this.clientsMetadata[client.id];
  }

  private disconnect(client: Socket, reason: string) {
    this.logger.info({
      message: `Connection disconnected ${client.id}: ${reason}`,
      where: `SyncGateway.handleConnection`,
    });
    client.disconnect(true);
  }
}

import {
  OnGatewayConnection,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { PrismaService } from 'nestjs-prisma';
import { Server, Socket } from 'socket.io';

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
export class SyncGateway implements OnGatewayInit, OnGatewayConnection {
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
  }

  private disconnect(client: Socket, reason: string) {
    this.logger.info({
      message: `Connection disconnected ${client.id}: ${reason}`,
      where: `SyncGateway.handleConnection`,
    });
    client.disconnect(true);
  }
}

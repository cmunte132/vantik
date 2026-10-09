import type { ConnectorRunEvent } from './connector.registry';
import type {
  ConnectorAck,
  ConnectorHello,
  ConnectorHelloAck,
  ConnectorSessionsWatchAck,
} from '@vantikhq/types';

import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import {
  CONNECTOR_NAMESPACE,
  CONNECTOR_PROTOCOL_VERSION,
  RoleEnum,
} from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';
import { Namespace, Socket } from 'socket.io';

import { isPatToken, resolvePatPrincipal } from 'common/pat-session';

import { LoggerService } from 'modules/logger/logger.service';

import {
  ConnectorPeer,
  ConnectorRegistry,
  ConnectorSocket,
  sanitizeModels,
} from './connector.registry';
import { SessionDriversService } from './session-drivers.service';

/** What the handshake proves, kept on the socket. */
interface ConnectorSocketData {
  peer: ConnectorPeer;
}

/** The members of a socket the gateway uses, so a spec needs no network. */
export type ConnectorSocketLike = Pick<Socket, 'id' | 'data' | 'disconnect'>;

/**
 * The door `vantik connect` knocks on.
 *
 * Its own namespace and its own authentication. The sync gateway trusts a
 * browser session cookie; this one trusts only a CLI token, and only a
 * person's own: an AGENT token is the credential of a run or an editor
 * session, and a connector acting with one would not be the person's machine.
 *
 * The connector never asks for work. It says hello, and the server pushes
 * `run.dispatch` when the person delegates an issue from the UI.
 */
@WebSocketGateway({ namespace: CONNECTOR_NAMESPACE })
export class ConnectorGateway implements OnGatewayInit, OnGatewayDisconnect {
  private readonly logger = new LoggerService('ConnectorGateway');

  constructor(
    private prisma: PrismaService,
    private registry: ConnectorRegistry,
    private drivers: SessionDriversService,
  ) {}

  afterInit(namespace: Namespace) {
    // Refused in the handshake, so the connector sees one clear error instead
    // of a connection that opens and closes.
    namespace.use((socket, next) => {
      void this.authenticate(socket).then(
        () => next(),
        (error: Error) => next(error),
      );
    });
  }

  /** Checks the handshake token and records who the socket is. */
  async authenticate(
    socket: Pick<Socket, 'handshake' | 'data'>,
  ): Promise<void> {
    const token = (socket.handshake.auth as { token?: unknown } | undefined)
      ?.token;

    if (typeof token !== 'string' || !isPatToken(token)) {
      throw new Error('Present your CLI token (tg_pat_...) as auth.token.');
    }

    const principal = await resolvePatPrincipal(this.prisma, token);

    // The same answer for a wrong token and an expired one.
    if (!principal) {
      throw new Error('The token is not valid, or it has expired.');
    }

    if (!principal.membership) {
      throw new Error('The token is not valid in a workspace you belong to.');
    }

    if (principal.membership.role === RoleEnum.AGENT) {
      throw new Error(
        'An agent token cannot run a connector. Use your own CLI token.',
      );
    }

    const data: ConnectorSocketData = {
      peer: {
        workspaceId: principal.membership.workspaceId,
        userId: principal.userId,
      },
    };
    socket.data = data;
  }

  /** The first message: describes the machine, and puts it in the registry. */
  @SubscribeMessage('hello')
  async hello(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: ConnectorHello,
  ): Promise<ConnectorHelloAck> {
    const ack = this.accept(socket, body);

    if (!ack.ok) {
      return ack;
    }

    // The watch list is a convenience: a failed read leaves the connector with
    // the sessions of its own runs only.
    const data = socket.data as ConnectorSocketData;
    const watchSessions = await this.drivers
      .watchList(data.peer)
      .catch((): string[] => []);

    return { ...ack, watchSessions };
  }

  accept(socket: ConnectorSocketLike, body: ConnectorHello): ConnectorHelloAck {
    const data = socket.data as ConnectorSocketData | undefined;

    if (!data?.peer) {
      return { ok: false, reason: 'The connection was not authenticated.' };
    }

    if (body?.protocolVersion !== CONNECTOR_PROTOCOL_VERSION) {
      return {
        ok: false,
        reason:
          `This connector speaks protocol ${body?.protocolVersion ?? 'unknown'} ` +
          `and the server speaks protocol ${CONNECTOR_PROTOCOL_VERSION}. ` +
          'Update the vantik CLI and connect again.',
      };
    }

    const models = sanitizeModels(body.models, body.defaultModel);

    this.registry.add({
      peer: data.peer,
      hello: {
        protocolVersion: body.protocolVersion,
        connectorVersion: String(body.connectorVersion ?? '').slice(0, 64),
        hostname: String(body.hostname ?? '').slice(0, 255),
        ompVersion:
          typeof body.ompVersion === 'string'
            ? body.ompVersion.slice(0, 64)
            : null,
        ompSupported: body.ompSupported !== false,
        ompAgentDir: body.ompAgentDir === true,
        ...(Array.isArray(body.activeRunIds)
          ? {
              activeRunIds: body.activeRunIds
                .filter((id): id is string => typeof id === 'string')
                .slice(0, 100),
            }
          : {}),
        ...(models
          ? { models: models.models, defaultModel: models.defaultModel }
          : {}),
      },
      socket: toRegistrySocket(socket),
      connectedAt: new Date(),
    });

    this.logger.info({
      message: `Connector online for user ${data.peer.userId} in workspace ${data.peer.workspaceId}`,
      where: 'ConnectorGateway.hello',
    });

    return {
      ok: true,
      userId: data.peer.userId,
      workspaceId: data.peer.workspaceId,
    };
  }

  /** The person's omp models changed (a login, a new default). */
  @SubscribeMessage('models')
  models(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): ConnectorAck {
    return this.updateModels(socket, body);
  }

  updateModels(
    socket: Pick<Socket, 'data' | 'id'>,
    body: unknown,
  ): ConnectorAck {
    const data = socket.data as ConnectorSocketData | undefined;
    const payload = body as { models?: unknown; defaultModel?: unknown };
    const models = sanitizeModels(payload?.models, payload?.defaultModel);

    if (!models) {
      return { ok: false, reason: 'Send models as a list.' };
    }

    if (!data?.peer || !this.registry.setModels(data.peer, socket.id, models)) {
      return { ok: false, reason: 'Say hello before sending models.' };
    }

    return { ok: true };
  }

  /** The connector asks again which sessions to watch. */
  @SubscribeMessage('sessions.watch')
  async watch(
    @ConnectedSocket() socket: Socket,
  ): Promise<ConnectorSessionsWatchAck> {
    const peer = this.onlinePeer(socket);

    if (!peer) {
      return { ok: false, reason: 'Say hello before asking for sessions.' };
    }

    try {
      return { ok: true, sessions: await this.drivers.watchList(peer) };
    } catch {
      return { ok: false, reason: 'The server could not list the sessions.' };
    }
  }

  /** Who holds each watched omp session changed. */
  @SubscribeMessage('sessions.drivers')
  async sessionDrivers(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<ConnectorAck> {
    const peer = this.onlinePeer(socket);

    if (!peer) {
      return { ok: false, reason: 'Say hello before sending sessions.' };
    }

    try {
      return await this.drivers.applyDrivers(
        peer,
        (body as { sessions?: unknown } | null)?.sessions,
      );
    } catch (error) {
      this.logger.error({
        message: `Recording session drivers failed: ${error}`,
        where: 'ConnectorGateway.sessionDrivers',
        error: error instanceof Error ? error : undefined,
      });

      return { ok: false, reason: 'The server could not record the drivers.' };
    }
  }

  /** The person behind a socket that has said hello, or undefined. */
  onlinePeer(socket: Pick<Socket, 'data' | 'id'>): ConnectorPeer | undefined {
    const data = socket.data as ConnectorSocketData | undefined;
    const online = data?.peer && this.registry.get(data.peer);

    return data?.peer && online && online.socket.id === socket.id
      ? data.peer
      : undefined;
  }

  @SubscribeMessage('run.started')
  started(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    return this.forward(socket, 'run.started', body);
  }

  @SubscribeMessage('run.events')
  events(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    return this.forward(socket, 'run.events', body);
  }

  @SubscribeMessage('run.entries')
  entries(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    return this.forward(socket, 'run.entries', body);
  }

  @SubscribeMessage('run.outbox')
  outbox(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    return this.forward(socket, 'run.outbox', body);
  }

  @SubscribeMessage('run.question')
  question(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    return this.forward(socket, 'run.question', body);
  }

  @SubscribeMessage('run.finished')
  finished(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    return this.forward(socket, 'run.finished', body);
  }

  handleDisconnect(socket: Socket) {
    const data = socket.data as ConnectorSocketData | undefined;

    if (data?.peer && this.registry.remove(data.peer, socket.id)) {
      this.logger.info({
        message: `Connector offline for user ${data.peer.userId}`,
        where: 'ConnectorGateway.handleDisconnect',
      });
    }
  }

  /**
   * Hands a run message to whatever runs the work. Only a connector that has
   * said hello may send one, and the handler checks that the run is this
   * person's.
   */
  async forward(
    socket: Pick<Socket, 'data' | 'id'>,
    event: ConnectorRunEvent,
    body: unknown,
  ): Promise<ConnectorAck> {
    const data = socket.data as ConnectorSocketData | undefined;
    const online = data?.peer && this.registry.get(data.peer);

    if (!data?.peer || !online || online.socket.id !== socket.id) {
      return { ok: false, reason: 'Say hello before sending run messages.' };
    }

    const handler = this.registry.getHandler();

    if (!handler) {
      return { ok: false, reason: 'This server does not run local agents.' };
    }

    try {
      return await handler.handle(data.peer, event, body);
    } catch (error) {
      this.logger.error({
        message: `Handling ${event} failed: ${error}`,
        where: 'ConnectorGateway.forward',
        error: error instanceof Error ? error : undefined,
      });

      return { ok: false, reason: 'The server could not handle the message.' };
    }
  }
}

function toRegistrySocket(socket: ConnectorSocketLike): ConnectorSocket {
  const live = socket as unknown as {
    timeout(ms: number): {
      emitWithAck(event: string, payload: unknown): Promise<unknown>;
    };
  };

  return {
    id: socket.id,
    emitWithAck: (event, payload, timeoutMs) =>
      live.timeout(timeoutMs).emitWithAck(event, payload),
    disconnect: () => {
      socket.disconnect(true);
    },
  };
}

import type {
  ConnectorAck,
  ConnectorHello,
  ConnectorModel,
  ConnectorModels,
  ConnectorRunDispatch,
} from '@vantikhq/types';

import { Injectable } from '@nestjs/common';

/** Who a connector is: the person whose token it presented. */
export interface ConnectorPeer {
  workspaceId: string;
  userId: string;
}

/** The messages a connector sends about a run, by their wire name. */
export type ConnectorRunEvent =
  'run.started' | 'run.events' | 'run.entries' | 'run.outbox' | 'run.finished';

/** The messages the server sends to a connector. */
export interface ConnectorOutbound {
  'run.dispatch': ConnectorRunDispatch;
  'run.cancel': { runId: string };
}

/** The part of a socket the registry needs, so a test needs no network. */
export interface ConnectorSocket {
  id: string;
  emitWithAck(
    event: string,
    payload: unknown,
    timeoutMs: number,
  ): Promise<unknown>;
  disconnect(): void;
}

export interface OnlineConnector {
  peer: ConnectorPeer;
  hello: ConnectorHello;
  socket: ConnectorSocket;
  connectedAt: Date;
}

/**
 * What handles a connector's run messages. The registry holds one so the
 * gateway does not depend on the agent-runs module, which depends on this one.
 */
export interface ConnectorRunHandler {
  /** One message about a run. The reply is the acknowledgement. */
  handle(
    peer: ConnectorPeer,
    event: ConnectorRunEvent,
    payload: unknown,
  ): Promise<ConnectorAck>;
  /** A connector for this person said hello, or came back. */
  connected(peer: ConnectorPeer, hello: ConnectorHello): void;
  /** The person's connector went away. */
  disconnected(peer: ConnectorPeer): void;
}

/** The most models one connector may report. */
export const MAX_CONNECTOR_MODELS = 1000;

const text = (value: unknown, max = 200): string | null =>
  typeof value === 'string' && value ? value.slice(0, max) : null;

/**
 * The models a connector reported, checked: strings only, at most
 * MAX_CONNECTOR_MODELS, an entry that is not well formed dropped. Null when
 * the value is not a model list at all.
 */
export function sanitizeModels(
  models: unknown,
  defaultModel: unknown,
): ConnectorModels | null {
  if (!Array.isArray(models)) {
    return null;
  }

  const clean: ConnectorModel[] = [];

  for (const entry of models.slice(0, MAX_CONNECTOR_MODELS)) {
    const provider = text(entry?.provider);
    const id = text(entry?.id);

    if (!provider || !id) {
      continue;
    }

    const levels: unknown = entry.thinkingLevels;

    clean.push({
      provider,
      id,
      name: text(entry.name) ?? id,
      reasoning: entry.reasoning === true,
      thinkingLevels: Array.isArray(levels)
        ? levels
            .map((level) => text(level, 32))
            .filter((level): level is string => level !== null)
            .slice(0, 16)
        : null,
    });
  }

  return { models: clean, defaultModel: text(defaultModel) };
}

const keyOf = (peer: ConnectorPeer) => `${peer.workspaceId}:${peer.userId}`;

/**
 * The connectors that are online now, one per person per workspace.
 *
 * In memory, so it is right for a single server process. Two replicas would
 * each know only their own connectors, and a delegation that reached the
 * other would find nobody online; sharing this needs a socket.io adapter and a
 * shared map, which is out of scope for the first version of the connector.
 *
 * A person who connects twice keeps the newer connection: the older one is the
 * stale socket of a process that is probably already gone.
 */
@Injectable()
export class ConnectorRegistry {
  private readonly online = new Map<string, OnlineConnector>();
  private handler: ConnectorRunHandler | undefined;

  setHandler(handler: ConnectorRunHandler): void {
    this.handler = handler;
  }

  getHandler(): ConnectorRunHandler | undefined {
    return this.handler;
  }

  add(connector: OnlineConnector): void {
    const previous = this.online.get(keyOf(connector.peer));
    this.online.set(keyOf(connector.peer), connector);

    if (previous && previous.socket.id !== connector.socket.id) {
      previous.socket.disconnect();
      // The old socket's own disconnect finds itself replaced and reports
      // nothing, so the loss is reported here. `connected` below settles it:
      // runs the new connector reports are kept, the rest fail.
      this.handler?.disconnected(connector.peer);
    }

    this.handler?.connected(connector.peer, connector.hello);
  }

  /** Forgets a socket. Returns whether the person is now offline. */
  remove(peer: ConnectorPeer, socketId: string): boolean {
    const current = this.online.get(keyOf(peer));

    // A newer connection already replaced this one; the person is still online.
    if (!current || current.socket.id !== socketId) {
      return false;
    }

    this.online.delete(keyOf(peer));
    this.handler?.disconnected(peer);

    return true;
  }

  /** Replaces the models of the person's connector, if this socket is it. */
  setModels(
    peer: ConnectorPeer,
    socketId: string,
    models: ConnectorModels,
  ): boolean {
    const current = this.online.get(keyOf(peer));

    if (!current || current.socket.id !== socketId) {
      return false;
    }

    current.hello = {
      ...current.hello,
      models: models.models,
      defaultModel: models.defaultModel,
    };

    return true;
  }

  get(peer: ConnectorPeer): OnlineConnector | undefined {
    return this.online.get(keyOf(peer));
  }

  /** Sends a message and waits for the connector to acknowledge it. */
  async send<E extends keyof ConnectorOutbound>(
    peer: ConnectorPeer,
    event: E,
    payload: ConnectorOutbound[E],
    timeoutMs = 15_000,
  ): Promise<ConnectorAck> {
    const connector = this.get(peer);

    if (!connector) {
      return { ok: false, reason: 'Your connector is not online.' };
    }

    try {
      const reply = (await connector.socket.emitWithAck(
        event,
        payload,
        timeoutMs,
      )) as ConnectorAck | undefined;

      // A connector that acknowledges with nothing at all took the message.
      return reply && typeof reply === 'object' && 'ok' in reply
        ? reply
        : { ok: true };
    } catch {
      return {
        ok: false,
        reason: 'Your connector did not acknowledge the message in time.',
      };
    }
  }
}

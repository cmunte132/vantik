import { io, type Socket } from 'socket.io-client';

import { SERVER_URL } from '../src/env';

/**
 * A `vantik connect` that is online, for a screenshot of what the webapp offers
 * only then. The server decides whether a person can run on their own machine
 * from the connector sockets it holds (see LocalExecutor.availability), so the
 * only honest way to show that choice is to connect one, the way the CLI does:
 * the person's CLI token in the handshake, then `hello`.
 *
 * It describes a laptop with omp installed and signed in to one provider. It
 * runs nothing, and the seed has no run for it to lose.
 */

const PROTOCOL_VERSION = 1;

const MODELS = [
  {
    provider: 'anthropic',
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    reasoning: true,
    thinkingLevels: ['minimal', 'low', 'medium', 'high'],
  },
  {
    provider: 'anthropic',
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    reasoning: true,
    thinkingLevels: ['minimal', 'low', 'medium', 'high'],
  },
];

export interface OnlineConnector {
  close(): void;
}

export async function connectConnector(token: string): Promise<OnlineConnector> {
  const socket: Socket = io(`${SERVER_URL}/connector`, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (error) =>
      reject(new Error(`the connector was refused: ${error.message}`)),
    );
  });

  const ack = await new Promise<{ ok: boolean; reason?: string }>((resolve) => {
    socket.emit(
      'hello',
      {
        protocolVersion: PROTOCOL_VERSION,
        connectorVersion: '2026.10.3',
        hostname: 'ada-laptop',
        ompVersion: '18.8.6',
        ompSupported: true,
        ompAgentDir: true,
        models: MODELS,
        defaultModel: 'anthropic/claude-sonnet-4-5',
      },
      resolve,
    );
  });
  if (!ack.ok) {
    socket.close();
    throw new Error(`the connector's hello was refused: ${ack.reason}`);
  }

  return { close: () => void socket.close() };
}

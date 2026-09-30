import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { type Duplex } from 'node:stream';

import { answerInvite, bearer, invite, inviteIdFor, onboard, provisionAccount, signIn } from '../../src/auth';
import { runTag, SERVER_URL, WEBAPP_URL } from '../../src/env';
import { expect, test } from '../../src/fixtures';

interface SessionSocket {
  socket: Duplex;
  closed: Promise<void>;
  ping(): Promise<void>;
}

async function upgrade(token: string, workspaceId: string, origin: string) {
  const url = new URL('/socket.io/', SERVER_URL);
  url.search = new URLSearchParams({ EIO: '4', transport: 'websocket', workspaceId }).toString();
  return new Promise<{ status: number; socket?: Duplex; head?: Buffer }>((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send(url, {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        Cookie: `sSessionToken=${token}`,
        Origin: origin,
      },
    });
    request.setTimeout(10_000, () => request.destroy(new Error('websocket upgrade timed out')));
    request.once('error', reject);
    request.once('response', (response) => {
      response.resume();
      resolve({ status: response.statusCode! });
    });
    request.once('upgrade', (response, socket, head) => {
      request.setTimeout(0);
      resolve({ status: response.statusCode!, socket, head });
    });
    request.end();
  });
}

function sendFrame(socket: Duplex, payload: Buffer, opcode = 1) {
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] ^= mask[index % 4];
  }
  socket.write(Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, masked]));
}

async function connect(token: string, workspaceId: string): Promise<SessionSocket> {
  const result = await upgrade(token, workspaceId, new URL(WEBAPP_URL).origin);
  expect(result.status).toBe(101);
  const socket = result.socket!;
  let pending = Buffer.alloc(0);
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolvePong: (() => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const closed = new Promise<void>((resolve) => {
    socket.once('close', () => {
      rejectReady(new Error('socket closed before authentication'));
      resolve();
    });
  });
  socket.on('error', rejectReady);
  const receive = (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const opcode = pending[0] & 0x0f;
      let length = pending[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (pending.length < 4) return;
        length = pending.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (pending.length < 10) return;
        length = Number(pending.readBigUInt64BE(2));
        offset = 10;
      }
      if (pending.length < offset + length) return;
      const payload = pending.subarray(offset, offset + length);
      pending = pending.subarray(offset + length);
      if (opcode === 10) resolvePong?.();
      if (opcode === 8) socket.end();
      if (opcode !== 1) continue;
      const packet = payload.toString();
      if (packet.startsWith('0')) sendFrame(socket, Buffer.from('40'));
      if (packet === '2') sendFrame(socket, Buffer.from('3'));
      if (packet.startsWith('42') && JSON.parse(packet.slice(2))[0] === 'server-version') resolveReady();
    }
  };
  socket.on('data', receive);
  if (result.head?.length) receive(result.head);
  const timeout = setTimeout(() => {
    rejectReady(new Error('socket authentication timed out'));
    socket.destroy();
  }, 10_000);
  try {
    await ready;
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  return {
    socket,
    closed,
    ping: () => new Promise<void>((resolve) => {
      resolvePong = resolve;
      sendFrame(socket, randomBytes(8), 9);
    }),
  };
}

test.describe('session websocket security', () => {
  test('rejects a cross-Origin websocket upgrade even with a valid cookie', async ({ request, alice }) => {
    const { session } = await signIn(request, `socket-origin+${runTag()}@e2e.vantik.test`);
    const result = await upgrade(session.accessToken, alice.workspaceId, 'https://untrusted.example');
    result.socket?.destroy();
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);
  });

  test('signout closes only the revoked session sockets', async ({ request }) => {
    const tag = runTag();
    const owner = await provisionAccount(request, {
      email: `socket-signout+${tag}@e2e.vantik.test`,
      fullname: 'Socket Signout',
      workspaceName: `Socket signout ${tag}`,
      teamIdentifier: 'SOCK',
    });
    const first = { session: { accessToken: owner.accessToken } };
    const second = await signIn(request, owner.email);
    const firstSocket = await connect(first.session.accessToken, owner.workspaceId);
    let secondSocket: SessionSocket | undefined;
    try {
      secondSocket = await connect(second.session.accessToken, owner.workspaceId);
      const response = await request.post(`${SERVER_URL}/v1/auth/signout`, {
        headers: {
          Cookie: `sSessionToken=${first.session.accessToken}`,
          Origin: new URL(WEBAPP_URL).origin,
        },
      });
      expect(response).toBeOK();
      await firstSocket.closed;
      await secondSocket.ping();
      await expect(connect(first.session.accessToken, owner.workspaceId)).rejects.toThrow('socket closed before authentication');
    } finally {
      firstSocket.socket.destroy();
      secondSocket?.socket.destroy();
    }
  });

  test('an invite moves one session and closes only its old workspace socket', async ({ request, alice }) => {
    const tag = runTag();
    const email = `socket-move+${tag}@e2e.vantik.test`;
    const first = await signIn(request, email);
    await onboard(request, first.session, {
      workspaceName: `Socket move ${tag}`,
      fullname: 'Socket Move',
      teamName: 'Socket Team',
      teamIdentifier: 'SOCK',
    });
    const ownWorkspaces = await request.get(`${SERVER_URL}/v1/workspaces`, {
      headers: bearer(first.session.accessToken),
    });
    expect(ownWorkspaces).toBeOK();
    const ownWorkspaceId = (await ownWorkspaces.json())[0].id as string;
    const second = await signIn(request, email);
    const firstSocket = await connect(first.session.accessToken, ownWorkspaceId);
    let secondSocket: SessionSocket | undefined;
    try {
      secondSocket = await connect(second.session.accessToken, ownWorkspaceId);
      await invite(request, alice, email, alice.teamId);
      const inviteId = await inviteIdFor(request, first.session, alice.workspaceId);
      const accepted = await answerInvite(request, first.session, inviteId);
      expect(accepted).toBeOK();
      expect(accepted.headers()['set-cookie']).toBeUndefined();
      await firstSocket.closed;
      await secondSocket.ping();
      const moved = await request.get(`${SERVER_URL}/v1/teams`, {
        headers: bearer(first.session.accessToken),
      });
      const unchanged = await request.get(`${SERVER_URL}/v1/teams`, {
        headers: bearer(second.session.accessToken),
      });
      expect(moved).toBeOK();
      expect(unchanged).toBeOK();
      expect((await moved.json()).map((team: { id: string }) => team.id)).toContain(alice.teamId);
      expect((await unchanged.json()).map((team: { identifier: string }) => team.identifier)).toEqual(['SOCK']);
    } finally {
      firstSocket.socket.destroy();
      secondSocket?.socket.destroy();
    }
  });
});

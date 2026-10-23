import type {
  ConnectorRunDispatch,
  ConnectorSessionActivity,
} from '@vantikhq/types';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Connector, type ActiveRun } from './connector';
import { AckedQueue } from './queue';
import { SessionDrivers } from './session-drivers';
import { SessionTail } from './session-tail';
import { vantikHome, worktreePathFor } from './worktree';

const dispatchFor = (runId: string, key: string, branch: string) =>
  ({
    runId,
    issue: { id: key, key, title: 'T' },
    repo: { id: 'r', fullName: 'acme/api', path: '/x', baseRef: 'main' },
    branch,
  }) as unknown as ConnectorRunDispatch;

describe('the runs a hello reports', () => {
  const transport = {
    connected: true,
    emit: (_event: string, _payload: unknown, ack: (a: { ok: true }) => void) =>
      ack({ ok: true }),
  };
  const install = { version: '18.8.6', agentDir: true };

  function connectorWith(finish: Map<string, () => void>) {
    const connector = new Connector({
      socketUrl: 'http://x',
      apiUrl: 'http://x',
      token: 't',
      connectorVersion: '1',
      extensionPath: '/e.js',
      log: () => undefined,
      createRun: (dispatch): ActiveRun => ({
        runId: dispatch.runId,
        branch: dispatch.branch,
        worktreePath: worktreePathFor(
          vantikHome(),
          dispatch.repo.fullName,
          dispatch.issue.key,
        ),
        queue: new AckedQueue(dispatch.runId, transport),
        cancel: () => undefined,
        answer: () => ({ ok: true }),
        start: () =>
          new Promise<void>((resolve) => finish.set(dispatch.runId, resolve)),
      }),
    });
    const dispatch = (d: ConnectorRunDispatch) =>
      (
        connector as unknown as {
          dispatch(d: ConnectorRunDispatch, t: unknown, i: unknown): void;
        }
      ).dispatch(d, transport, install);
    return { connector, dispatch };
  }

  it('lists a run from the moment its dispatch is accepted until it ends', async () => {
    const finish = new Map<string, () => void>();
    const { connector, dispatch } = connectorWith(finish);
    expect(connector.hello(install).activeRunIds).toEqual([]);

    dispatch(dispatchFor('run-1', 'ENG-1', 'agent/eng-1'));
    dispatch(dispatchFor('run-2', 'ENG-2', 'agent/eng-2'));
    // A reconnect now, before either run has started omp, still reports both.
    expect(connector.hello(install).activeRunIds).toEqual(['run-1', 'run-2']);

    finish.get('run-1')?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(connector.hello(install).activeRunIds).toEqual(['run-2']);
  });

  it('does not list a dispatch it refused for a busy worktree', () => {
    const { connector, dispatch } = connectorWith(new Map());
    dispatch(dispatchFor('run-1', 'ENG-1', 'agent/eng-1'));
    dispatch(dispatchFor('run-3', 'ENG-1', 'agent/other'));

    expect(connector.hello(install).activeRunIds).toEqual(['run-1']);
  });
});

describe('the session activity a connector sends', () => {
  const ROOT = '01a1212b-ef89-7545-abb3-1339176a6b81';
  const CHILD = '03c3212b-ef89-7545-abb3-1339176a6b81';
  const stem = `2026-10-09T10-00-00-000Z_${ROOT}`;
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  const message = (id: string, text: string) =>
    line({
      type: 'message',
      id,
      timestamp: '2026-10-09T10:05:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });

  let dir: string;
  let childFile: string;
  let sent: Array<{ event: string; payload: ConnectorSessionActivity }>;
  let accept: boolean;
  let connector: Connector;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'connector-activity-'));
    const sessions = path.join(dir, 'sessions', '-work');
    mkdirSync(path.join(sessions, stem), { recursive: true });
    writeFileSync(
      path.join(sessions, `${stem}.jsonl`),
      line({ type: 'session', id: ROOT }) + message('r1', 'root'),
    );
    childFile = path.join(
      sessions,
      stem,
      `2026-10-09T10-05-00-000Z_${CHILD}.jsonl`,
    );

    sent = [];
    accept = true;
    const drivers = new SessionDrivers({ log: () => undefined });
    drivers.setWatched([ROOT]);
    connector = new Connector({
      socketUrl: 'http://x',
      apiUrl: 'http://x',
      token: 't',
      connectorVersion: '1',
      extensionPath: '/e.js',
      log: () => undefined,
      drivers,
      tail: new SessionTail({
        agentDir: () => dir,
        stateFile: path.join(dir, 'state', 'offsets.json'),
        log: () => undefined,
      }),
    });
    // The server answers each message; `accept` decides whether it takes it.
    (connector as unknown as { socket: unknown }).socket = {
      connected: true,
      emit: (
        event: string,
        payload: ConnectorSessionActivity,
        ack: (result: { ok: boolean }) => void,
      ) => {
        sent.push({ event, payload });
        ack({ ok: accept });
      },
    };
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("sends a child session under its root with the child's own id and start, and the root without them", async () => {
    await connector.tailSessions();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.event).toBe('sessions.activity');
    expect(sent[0]?.payload).toEqual({
      externalId: ROOT,
      entries: [expect.objectContaining({ id: 'r1' })],
    });

    writeFileSync(
      childFile,
      line({
        type: 'session',
        id: CHILD,
        timestamp: '2026-10-09T10:05:00.000Z',
      }) + message('c1', 'child work'),
    );
    await connector.tailSessions();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.payload).toEqual({
      externalId: ROOT,
      sourceSessionId: CHILD,
      sourceStartedAt: '2026-10-09T10:05:00.000Z',
      entries: [expect.objectContaining({ id: 'c1' })],
    });

    await connector.tailSessions();
    expect(sent).toHaveLength(2);
  });

  it('sends a child batch again with the same entries until the server acknowledges it', async () => {
    await connector.tailSessions();
    writeFileSync(
      childFile,
      line({ type: 'session', id: CHILD }) + message('c1', 'child work'),
    );

    accept = false;
    await connector.tailSessions();
    accept = true;
    await connector.tailSessions();
    await connector.tailSessions();

    const childSends = sent.filter(
      (send) => send.payload.sourceSessionId === CHILD,
    );
    expect(childSends).toHaveLength(2);
    expect(childSends[1]?.payload).toEqual(childSends[0]?.payload);
  });
});

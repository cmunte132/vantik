import type { ConnectorRunDispatch } from '@vantikhq/types';

import { Connector, type ActiveRun } from './connector';
import { AckedQueue } from './queue';
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

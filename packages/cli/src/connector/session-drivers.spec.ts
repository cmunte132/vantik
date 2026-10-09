import { ompArgs } from './omp';
import { assertSessionFree } from './run';
import {
  type HolderMap,
  ownerLockPath,
  parseLsof,
  SessionDrivers,
} from './session-drivers';

const A = '01a11e21-8ec7-763d-b981-ef21a2f3a662';
const B = '01a11e44-2caa-710c-b439-f6593eda5fef';
const lock = (id: string) => `/locks/${id}.lock`;

function build(initial: HolderMap | null = new Map()) {
  let holders: HolderMap | null = initial;
  const calls: string[][] = [];
  const parents = new Map<number, number>();
  const drivers = new SessionDrivers({
    log: () => undefined,
    lockPath: lock,
    holders: async (files) => {
      calls.push(files);
      return holders;
    },
    parentOf: async (pid) => parents.get(pid) ?? null,
  });
  return {
    drivers,
    calls,
    parents,
    hold(next: HolderMap | null) {
      holders = next;
    },
  };
}

describe('reading lsof output', () => {
  it('maps each file to the processes that hold it', () => {
    const map = parseLsof(
      'p100\nf3\nn/a.lock\np200\nf4\nn/a.lock\nf5\nn/b.lock\n',
    );
    expect(map.get('/a.lock')).toEqual([100, 200]);
    expect(map.get('/b.lock')).toEqual([200]);
  });
});

describe('the lock path of a session', () => {
  it('sits in the session-owners directory of omp', () => {
    expect(ownerLockPath(A, '/home/me/.omp/run')).toBe(
      `/home/me/.omp/run/session-owners/${A}.lock`,
    );
  });
});

describe('who drives a session', () => {
  it('says TERMINAL for a holder that is not the connector, VANTIK for its own omp, and null for nobody', async () => {
    const t = build(
      new Map([
        [lock(A), [500]],
        [lock(B), [900]],
      ]),
    );
    t.drivers.setWatched([A]);
    t.drivers.syncRuns([{ sessionId: B, pid: 900 }]);

    const changes = await t.drivers.poll();
    expect(changes).toEqual(
      expect.arrayContaining([
        { externalId: A, driver: 'TERMINAL' },
        { externalId: B, driver: 'VANTIK' },
      ]),
    );

    t.drivers.commit(changes);
    t.hold(new Map());
    await expect(t.drivers.poll()).resolves.toEqual(
      expect.arrayContaining([
        { externalId: A, driver: null },
        { externalId: B, driver: null },
      ]),
    );
  });

  it("counts a child of the connector's omp as its own", async () => {
    const t = build(new Map([[lock(B), [901]]]));
    t.parents.set(901, 900);
    t.drivers.syncRuns([{ sessionId: B, pid: 900 }]);

    await expect(t.drivers.poll()).resolves.toEqual([
      { externalId: B, driver: 'VANTIK' },
    ]);
  });

  it('asks lsof once for all files, and reports changes only', async () => {
    const t = build(new Map([[lock(A), [500]]]));
    t.drivers.setWatched([A, B]);

    const first = await t.drivers.poll();
    expect(t.calls).toHaveLength(1);
    expect([...(t.calls[0] ?? [])].sort()).toEqual([lock(A), lock(B)].sort());
    expect(first).toHaveLength(2);

    // Not acknowledged yet: the same report goes again.
    expect(await t.drivers.poll()).toHaveLength(2);

    t.drivers.commit(first);
    expect(await t.drivers.poll()).toEqual([]);

    t.drivers.resetReported();
    expect(await t.drivers.poll()).toHaveLength(2);
  });

  it('repeats a driver before the server lease runs out', async () => {
    let now = 1_000_000;
    const drivers = new SessionDrivers({
      log: () => undefined,
      lockPath: lock,
      now: () => now,
      holders: async () => new Map([[lock(A), [500]]]),
    });
    drivers.setWatched([A]);

    drivers.commit(await drivers.poll());
    now += 15_000;
    expect(await drivers.poll()).toEqual([]);
    now += 30_000;
    expect(await drivers.poll()).toEqual([
      { externalId: A, driver: 'TERMINAL' },
    ]);
  });

  it('skips the check when lsof is missing', async () => {
    const t = build(null);
    t.drivers.setWatched([A]);
    await expect(t.drivers.poll()).resolves.toEqual([]);
  });

  it('keeps the session of a finished run on the list', async () => {
    const t = build(new Map([[lock(B), [500]]]));
    t.drivers.syncRuns([{ sessionId: B, pid: 900 }]);
    t.drivers.syncRuns([]);

    // Its omp is gone and a terminal now holds the session.
    await expect(t.drivers.poll()).resolves.toEqual([
      { externalId: B, driver: 'TERMINAL' },
    ]);
  });
});

describe('never writing to a held session', () => {
  it('finds a session held by a terminal, and one held by its own omp as free', async () => {
    const t = build(
      new Map([
        [lock(A), [500]],
        [lock(B), [900]],
      ]),
    );
    t.drivers.syncRuns([{ sessionId: B, pid: 900 }]);

    await expect(t.drivers.isHeldByOther(A)).resolves.toBe(true);
    await expect(t.drivers.isHeldByOther(B)).resolves.toBe(false);
    t.hold(new Map());
    await expect(t.drivers.isHeldByOther(A)).resolves.toBe(false);
  });

  it('counts a session as held when the check cannot run', async () => {
    const t = build(null);
    await expect(t.drivers.isHeldByOther(A)).resolves.toBe(true);
  });

  it('refuses a resume with a clear reason when a terminal holds the session', async () => {
    await expect(assertSessionFree(A, async () => true)).rejects.toThrow(
      /open in a terminal/,
    );
    await expect(assertSessionFree(A, async () => false)).resolves.toBe(
      undefined,
    );
    await expect(assertSessionFree(A, undefined)).rejects.toThrow(
      /cannot check/,
    );
  });

  it('passes --resume to omp only for a dispatch that names a session', () => {
    const model = { provider: null, model: null, thinking: null };
    expect(ompArgs({ model }, '/e.js')).not.toContain('--resume');
    expect(ompArgs({ model, resumeSessionId: A }, '/e.js')).toEqual(
      expect.arrayContaining(['--resume', A]),
    );
  });
});

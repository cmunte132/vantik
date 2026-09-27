/**
 * What a run's end, and its pull request, say about the knowledge it was
 * handed.
 *
 * Against an in-memory store that keeps the one-row-per-entry-run-and-source
 * rule, because the counts are only worth anything if an outcome reported
 * twice moves them once, and a later outcome replaces an earlier one rather
 * than adding to it.
 */
import type { Queue } from 'bull';

import { PrismaService } from 'nestjs-prisma';

import { RECHECK_ENTRY_JOB } from 'modules/pages/pages.interface';

import {
  isUnder,
  KnowledgeSignalsService,
  repoNameOf,
  WEAK_SIGNAL,
} from './knowledge-signals.service';

const WORKSPACE = 'workspace-1';
const RUN = 'run-1';
const PR = 'https://github.com/acme/api/pull/7';

interface Pass {
  verificationPassed: boolean | null;
  accepted: boolean | null;
  findings?: unknown;
  failedChecks?: unknown;
}

interface Entry {
  id: string;
  scope: string | null;
  citations: Array<{ path: string | null; repo?: string | null }>;
  helpfulCount: number;
  harmfulCount: number;
  status: string;
}

interface Run {
  id: string;
  workspaceId: string;
  status: string;
  config: unknown;
  result: unknown;
  deleted: Date | null;
  pullRequestOutcome: string | null;
  pullRequestClosedAt: Date | null;
  passes: Pass[];
  served: string[];
  createdAt: Date;
}

function entry(id: string, overrides: Partial<Entry> = {}): Entry {
  return {
    id,
    scope: null,
    citations: [],
    helpfulCount: 0,
    harmfulCount: 0,
    status: 'STANDING',
    ...overrides,
  };
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: RUN,
    workspaceId: WORKSPACE,
    status: 'SUCCEEDED',
    config: { repoUrl: 'https://github.com/acme/api.git' },
    result: { prUrl: PR },
    deleted: null,
    pullRequestOutcome: null,
    pullRequestClosedAt: null,
    passes: [{ verificationPassed: true, accepted: true, findings: [] }],
    served: [],
    createdAt: new Date('2026-09-01T10:00:00Z'),
    ...overrides,
  };
}

function build(options: { runs: Run[]; entries: Entry[] }) {
  const runs = new Map(options.runs.map((row) => [row.id, row]));
  const entries = new Map(options.entries.map((row) => [row.id, row]));
  const signals: Array<{
    id: string;
    entryId: string;
    agentRunId: string;
    source: string;
    kind: string;
    weight: number;
    evidence: string | null;
  }> = [];
  const keyOf = (where: {
    entryId: string;
    agentRunId: string;
    source: string;
  }) =>
    signals.find(
      (signal) =>
        signal.entryId === where.entryId &&
        signal.agentRunId === where.agentRunId &&
        signal.source === where.source,
    );

  const prisma = {
    agentRun: {
      findUnique: jest.fn(async ({ where, select }) => {
        const row = runs.get(where.id);
        if (!row) {
          return null;
        }
        // The passes are stored in index order; the order and count asked
        // for are honoured, so reading the wrong pass reads the wrong one here.
        const { orderBy, take } = select.iterations;
        const ordered =
          orderBy?.index === 'desc' ? [...row.passes].reverse() : row.passes;
        return {
          id: row.id,
          status: row.status,
          config: row.config,
          iterations: ordered.slice(0, take ?? ordered.length),
        };
      }),
      // By a field of the run's result (its pull request's address, or the
      // branch it pushed), optionally created by a time, newest first.
      findMany: jest.fn(async ({ where, orderBy, take }) => {
        const [key] = where.result.path as string[];
        const found = [...runs.values()].filter(
          (row) =>
            row.workspaceId === where.workspaceId &&
            row.deleted === null &&
            (row.result as Record<string, unknown> | null)?.[key] ===
              where.result.equals &&
            (!where.createdAt || row.createdAt <= where.createdAt.lte),
        );
        if (orderBy?.createdAt) {
          const direction = orderBy.createdAt === 'desc' ? -1 : 1;
          found.sort(
            (a, b) =>
              direction * (a.createdAt.getTime() - b.createdAt.getTime()),
          );
        }
        return found.slice(0, take ?? found.length).map((row) => ({
          id: row.id,
          config: row.config,
          result: row.result,
        }));
      }),
      update: jest.fn(async ({ where, data }) =>
        Object.assign(runs.get(where.id) as Run, data),
      ),
    },
    pageEntryUse: {
      findMany: jest.fn(async ({ where }) =>
        [...new Set(runs.get(where.agentRunId)?.served ?? [])].map(
          (entryId) => ({ entryId }),
        ),
      ),
    },
    pageEntry: {
      findMany: jest.fn(async ({ where }) =>
        where.id.in
          .map((id: string) => entries.get(id))
          .filter(Boolean)
          .map((row: Entry) => ({
            id: row.id,
            scope: row.scope,
            citations: row.citations.map((citation) => ({
              path: citation.path,
              moduleRepo:
                citation.repo === null
                  ? null
                  : { fullName: citation.repo ?? 'acme/api' },
            })),
          })),
      ),
      update: jest.fn(async ({ where, data }) => {
        const row = entries.get(where.id) as Entry;
        row.helpfulCount += data.helpfulCount.increment;
        row.harmfulCount += data.harmfulCount.increment;
        return row;
      }),
    },
    pageEntrySignal: {
      createMany: jest.fn(async ({ data }) => {
        const [row] = data;
        if (keyOf(row)) {
          return { count: 0 };
        }
        signals.push({ id: `signal-${signals.length + 1}`, ...row });
        return { count: 1 };
      }),
      // A copy, as a query returns, not the stored row itself.
      findUnique: jest.fn(async ({ where }) => {
        const row = keyOf(where.entryId_agentRunId_source);
        return row ? { ...row } : null;
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const row = signals.find(
          (signal) =>
            signal.id === where.id &&
            signal.kind === where.kind &&
            signal.weight === where.weight,
        );
        if (!row) {
          return { count: 0 };
        }
        Object.assign(row, data);
        return { count: 1 };
      }),
      deleteMany: jest.fn(async ({ where }) => {
        const index = signals.findIndex(
          (signal) =>
            signal.id === where.id &&
            signal.kind === where.kind &&
            signal.weight === where.weight,
        );
        if (index === -1) {
          return { count: 0 };
        }
        signals.splice(index, 1);
        return { count: 1 };
      }),
    },
    $transaction: jest.fn(
      async (work: (tx: unknown) => unknown): Promise<unknown> => work(prisma),
    ),
  };

  const queue = { add: jest.fn(async () => ({})) };
  const service = new KnowledgeSignalsService(
    prisma as unknown as PrismaService,
    queue as unknown as Queue,
  );

  return { service, prisma, queue, entries, runs, signals };
}

const counts = (row?: Entry) => [row?.helpfulCount, row?.harmfulCount];

describe('the signals a run’s end gives its knowledge', () => {
  it('[KG-3.4] is helpful to every entry served when the checks passed and the reviewer accepted', async () => {
    const { service, entries, signals } = build({
      runs: [run({ served: ['a', 'b'] })],
      entries: [entry('a'), entry('b')],
    });

    await expect(service.runFinished(RUN)).resolves.toEqual({
      helpful: 2,
      harmful: 0,
    });

    expect(counts(entries.get('a'))).toEqual([1, 0]);
    expect(counts(entries.get('b'))).toEqual([1, 0]);
    expect(signals).toEqual([
      expect.objectContaining({
        entryId: 'a',
        source: 'RUN',
        kind: 'HELPFUL',
        weight: 1,
      }),
      expect.objectContaining({
        entryId: 'b',
        source: 'RUN',
        kind: 'HELPFUL',
        weight: 1,
      }),
    ]);
  });

  it('[KG-3.4] is harmful to an entry a finding points into, by a file it cites', async () => {
    const { service, entries, signals } = build({
      runs: [
        run({
          served: ['cited', 'elsewhere'],
          passes: [
            {
              verificationPassed: true,
              accepted: true,
              findings: [
                { message: 'Evicts live keys', evidence: 'src/cache.ts:42' },
              ],
            },
          ],
        }),
      ],
      entries: [
        entry('cited', { citations: [{ path: 'src/cache.ts' }] }),
        entry('elsewhere', { citations: [{ path: 'src/queue.ts' }] }),
      ],
    });

    await service.runFinished(RUN);

    expect(counts(entries.get('cited'))).toEqual([0, 1]);
    // Nothing pointed at the other, and the work was accepted.
    expect(counts(entries.get('elsewhere'))).toEqual([1, 0]);
    expect(signals.find((signal) => signal.entryId === 'cited')).toMatchObject({
      kind: 'HARMFUL',
      evidence: 'review finding at src/cache.ts:42',
    });
  });

  it('[KG-3.4] is harmful to an entry whose scope the evidence falls under', async () => {
    const { service, entries } = build({
      runs: [
        run({
          served: ['scoped', 'sibling'],
          passes: [
            {
              verificationPassed: true,
              accepted: false,
              findings: [
                {
                  message: 'Drops the index',
                  evidence: '`apps/server/prisma/schema.prisma:10`',
                },
              ],
            },
          ],
        }),
      ],
      entries: [
        entry('scoped', { scope: 'apps/server/**' }),
        // A folder that only starts the same is not the same folder.
        entry('sibling', { scope: 'apps/server-legacy' }),
      ],
    });

    await service.runFinished(RUN);

    expect(counts(entries.get('scoped'))).toEqual([0, 1]);
    // Not accepted, and nothing pointed at it: no signal either way.
    expect(counts(entries.get('sibling'))).toEqual([0, 0]);
  });

  it('[KG-3.4] is harmful to an entry a failing check failed in', async () => {
    const { service, entries, signals } = build({
      runs: [
        run({
          status: 'NEEDS_REVIEW',
          served: ['cited'],
          passes: [
            {
              verificationPassed: false,
              accepted: null,
              failedChecks: [
                {
                  label: 'test',
                  command: 'pnpm test',
                  paths: ['src/cache.spec.ts', 'src/cache.ts'],
                },
              ],
            },
          ],
        }),
      ],
      entries: [entry('cited', { citations: [{ path: 'src/cache.ts' }] })],
    });

    await service.runFinished(RUN);

    expect(counts(entries.get('cited'))).toEqual([0, 1]);
    expect(signals[0].evidence).toBe('test failed in src/cache.ts');
  });

  it('[KG-3.4] says nothing about an entry when the run went wrong somewhere it does not speak about', async () => {
    const { service, entries, signals } = build({
      runs: [
        run({
          status: 'FAILED',
          served: ['cited'],
          passes: [
            {
              verificationPassed: false,
              accepted: false,
              findings: [{ message: 'Wrong', evidence: 'src/other.ts:1' }],
              failedChecks: [
                {
                  label: 'lint',
                  command: 'pnpm lint',
                  paths: ['src/other.ts'],
                },
              ],
            },
          ],
        }),
      ],
      entries: [entry('cited', { citations: [{ path: 'src/cache.ts' }] })],
    });

    await expect(service.runFinished(RUN)).resolves.toEqual({
      helpful: 0,
      harmful: 0,
    });
    expect(counts(entries.get('cited'))).toEqual([0, 0]);
    expect(signals).toEqual([]);
  });

  it('[KG-3.4] is helpful only when the checks passed and the reviewer accepted, both', async () => {
    // A check failed somewhere no served entry speaks about, and the reviewer
    // accepted anyway: nothing here says the knowledge helped.
    const checksFailed = build({
      runs: [
        run({
          served: ['cited'],
          passes: [
            {
              verificationPassed: false,
              accepted: true,
              findings: [],
              failedChecks: [
                {
                  label: 'lint',
                  command: 'pnpm lint',
                  paths: ['src/other.ts'],
                },
              ],
            },
          ],
        }),
      ],
      entries: [entry('cited', { citations: [{ path: 'src/cache.ts' }] })],
    });

    await checksFailed.service.runFinished(RUN);
    expect(counts(checksFailed.entries.get('cited'))).toEqual([0, 0]);

    // The checks passed and the reviewer did not accept.
    const notAccepted = build({
      runs: [
        run({
          served: ['cited'],
          passes: [{ verificationPassed: true, accepted: false, findings: [] }],
        }),
      ],
      entries: [entry('cited', { citations: [{ path: 'src/cache.ts' }] })],
    });

    await notAccepted.service.runFinished(RUN);
    expect(counts(notAccepted.entries.get('cited'))).toEqual([0, 0]);
    expect(checksFailed.signals).toEqual([]);
    expect(notAccepted.signals).toEqual([]);
  });

  it('[KG-3.4] reads the last pass, whose findings are the ones still standing', async () => {
    const { service, entries } = build({
      runs: [
        run({
          served: ['cited'],
          passes: [
            {
              verificationPassed: false,
              accepted: false,
              findings: [{ message: 'Broken', evidence: 'src/cache.ts:3' }],
            },
            { verificationPassed: true, accepted: true, findings: [] },
          ],
        }),
      ],
      entries: [entry('cited', { citations: [{ path: 'src/cache.ts' }] })],
    });

    await service.runFinished(RUN);

    expect(counts(entries.get('cited'))).toEqual([1, 0]);
  });

  it('[KG-3.4] has a harmful signal checked again, and archives or deletes nothing', async () => {
    const { service, prisma, queue } = build({
      runs: [
        run({
          served: ['cited', 'other'],
          passes: [
            {
              verificationPassed: true,
              accepted: true,
              findings: [{ message: 'Stale', evidence: 'src/cache.ts:9' }],
            },
          ],
        }),
      ],
      entries: [
        entry('cited', { citations: [{ path: 'src/cache.ts' }] }),
        entry('other'),
      ],
    });

    await service.runFinished(RUN);

    // One check, of the entry the harm pointed at, and none for the helpful.
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      RECHECK_ENTRY_JOB,
      { entryId: 'cited' },
      expect.objectContaining({ jobId: `${RECHECK_ENTRY_JOB}:cited` }),
    );
    // The only write to an entry is its counts.
    for (const [{ data }] of prisma.pageEntry.update.mock.calls) {
      expect(Object.keys(data).sort()).toEqual([
        'harmfulCount',
        'helpfulCount',
      ]);
    }
  });

  it('[KG-6.5] answers harm with a check of each entry it points at, never with a status', async () => {
    const { service, prisma, queue } = build({
      runs: [
        run({
          served: ['first', 'second'],
          passes: [
            {
              verificationPassed: false,
              accepted: false,
              findings: [{ message: 'Stale', evidence: 'src/cache.ts:9' }],
            },
          ],
        }),
      ],
      entries: [
        entry('first', { citations: [{ path: 'src/cache.ts' }] }),
        entry('second', { citations: [{ path: 'src/cache.ts' }] }),
      ],
    });

    await service.runFinished(RUN);

    expect(queue.add).toHaveBeenCalledTimes(2);
    for (const entryId of ['first', 'second']) {
      expect(queue.add).toHaveBeenCalledWith(
        RECHECK_ENTRY_JOB,
        { entryId },
        expect.objectContaining({ jobId: `${RECHECK_ENTRY_JOB}:${entryId}` }),
      );
    }
    for (const [{ data }] of prisma.pageEntry.update.mock.calls) {
      expect(data).not.toHaveProperty('status');
    }
  });

  it('[KG-3.4] counts a run’s end once, however often it is attributed', async () => {
    const { service, entries, signals, queue } = build({
      runs: [
        run({
          served: ['a', 'cited'],
          passes: [
            {
              verificationPassed: true,
              accepted: true,
              findings: [{ message: 'x', evidence: 'src/cache.ts:1' }],
            },
          ],
        }),
      ],
      entries: [
        entry('a'),
        entry('cited', { citations: [{ path: 'src/cache.ts' }] }),
      ],
    });

    await service.runFinished(RUN);
    await service.runFinished(RUN);

    expect(counts(entries.get('a'))).toEqual([1, 0]);
    expect(counts(entries.get('cited'))).toEqual([0, 1]);
    expect(signals).toHaveLength(2);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('[KG-3.4] gives nothing for a run canceled or expired, or one that never checked its work', async () => {
    for (const shape of [
      { status: 'CANCELED' },
      { status: 'EXPIRED' },
      { status: 'FAILED', passes: [] as Pass[] },
    ]) {
      const { service, signals } = build({
        runs: [run({ served: ['a'], ...shape })],
        entries: [entry('a')],
      });

      await expect(service.runFinished(RUN)).resolves.toEqual({
        helpful: 0,
        harmful: 0,
      });
      expect(signals).toEqual([]);
    }
  });

  it('[KG-3.4] gives nothing to a run held out, which was served nothing', async () => {
    const { service, signals, prisma } = build({
      runs: [run({ served: [] })],
      entries: [entry('a')],
    });

    await service.runFinished(RUN);

    expect(signals).toEqual([]);
    expect(prisma.pageEntry.findMany).not.toHaveBeenCalled();
  });

  it('[KG-3.4] does not match a file of the same name in another repository', async () => {
    const { service, entries } = build({
      runs: [
        run({
          served: ['theirs'],
          passes: [
            {
              verificationPassed: true,
              accepted: false,
              findings: [{ message: 'x', evidence: 'src/index.ts:1' }],
            },
          ],
        }),
      ],
      entries: [
        entry('theirs', {
          citations: [{ path: 'src/index.ts', repo: 'acme/web' }],
        }),
      ],
    });

    await service.runFinished(RUN);

    expect(counts(entries.get('theirs'))).toEqual([0, 0]);
  });

  it('[KG-3.4] keeps recording the other signals when one cannot be written', async () => {
    const { service, prisma, entries } = build({
      runs: [run({ served: ['a', 'b'] })],
      entries: [entry('a'), entry('b')],
    });
    prisma.pageEntrySignal.createMany.mockRejectedValueOnce(
      new Error('connection reset'),
    );

    await service.runFinished(RUN);

    expect(counts(entries.get('b'))).toEqual([1, 0]);
  });
});

describe('the signals a pull request gives the knowledge of the run that opened it', () => {
  it('[KG-3.5] is helpful to every entry the run was served when it merges', async () => {
    const closedAt = new Date('2026-09-26T12:00:00Z');
    const { service, entries, runs, signals } = build({
      runs: [run({ served: ['a', 'b'] })],
      entries: [entry('a'), entry('b')],
    });

    await expect(
      service.pullRequestChanged({
        workspaceId: WORKSPACE,
        url: PR,
        state: 'MERGED',
        closedAt,
      }),
    ).resolves.toEqual({ runs: 1 });

    expect(counts(entries.get('a'))).toEqual([1, 0]);
    expect(counts(entries.get('b'))).toEqual([1, 0]);
    expect(signals.every((signal) => signal.source === 'PULL_REQUEST')).toBe(
      true,
    );
    expect(runs.get(RUN)).toMatchObject({
      pullRequestOutcome: 'MERGED',
      pullRequestClosedAt: closedAt,
    });
  });

  it('[KG-3.5] is weakly harmful when it is closed without merging, and has the entry checked', async () => {
    const { service, entries, runs, queue, signals } = build({
      runs: [run({ served: ['a'] })],
      entries: [entry('a')],
    });

    await service.pullRequestChanged({
      workspaceId: WORKSPACE,
      url: PR,
      state: 'CLOSED',
    });

    expect(WEAK_SIGNAL).toBeLessThan(1);
    expect(counts(entries.get('a'))).toEqual([0, WEAK_SIGNAL]);
    expect(signals[0]).toMatchObject({
      kind: 'HARMFUL',
      weight: WEAK_SIGNAL,
      evidence: `${PR} was closed without merging`,
    });
    expect(runs.get(RUN)?.pullRequestOutcome).toBe('CLOSED');
    expect(queue.add).toHaveBeenCalledWith(
      RECHECK_ENTRY_JOB,
      { entryId: 'a' },
      expect.anything(),
    );
  });

  it('[KG-3.5] replaces a close with the merge that follows a reopen, rather than counting both', async () => {
    const { service, entries, runs, signals } = build({
      runs: [run({ served: ['a'] })],
      entries: [entry('a')],
    });

    await service.pullRequestChanged({
      workspaceId: WORKSPACE,
      url: PR,
      state: 'CLOSED',
    });
    await service.pullRequestChanged({
      workspaceId: WORKSPACE,
      url: PR,
      state: 'OPEN',
    });

    // Reopened: the close is taken back, and the run's pull request is open.
    expect(counts(entries.get('a'))).toEqual([0, 0]);
    expect(signals).toEqual([]);
    expect(runs.get(RUN)?.pullRequestOutcome).toBeNull();

    await service.pullRequestChanged({
      workspaceId: WORKSPACE,
      url: PR,
      state: 'CLOSED',
    });
    // A merge reported straight after a close (no reopen seen) replaces it.
    await service.pullRequestChanged({
      workspaceId: WORKSPACE,
      url: PR,
      state: 'MERGED',
    });
    await service.pullRequestChanged({
      workspaceId: WORKSPACE,
      url: PR,
      state: 'MERGED',
    });

    expect(counts(entries.get('a'))).toEqual([1, 0]);
    expect(signals).toHaveLength(1);
  });

  it('[KG-3.5] keeps the run’s signal and the pull request’s apart', async () => {
    const { service, entries } = build({
      runs: [run({ served: ['a'] })],
      entries: [entry('a')],
    });

    await service.runFinished(RUN);
    await service.pullRequestChanged({
      workspaceId: WORKSPACE,
      url: PR,
      state: 'MERGED',
    });

    expect(counts(entries.get('a'))).toEqual([2, 0]);
  });

  it('[KG-3.5] credits only the run that opened it, in the workspace that saw it', async () => {
    const { service, prisma, runs } = build({
      runs: [
        run({ served: ['a'] }),
        run({
          id: 'run-other-pr',
          served: ['a'],
          result: { prUrl: 'https://github.com/acme/api/pull/8' },
        }),
        run({ id: 'run-elsewhere', workspaceId: 'workspace-2', served: ['a'] }),
      ],
      entries: [entry('a')],
    });

    await service.pullRequestChanged({
      workspaceId: WORKSPACE,
      url: PR,
      state: 'MERGED',
    });

    expect(prisma.agentRun.findMany.mock.calls[0][0].where).toMatchObject({
      workspaceId: WORKSPACE,
      result: { path: ['prUrl'], equals: PR },
    });
    expect(runs.get('run-other-pr')?.pullRequestOutcome).toBeNull();
    expect(runs.get('run-elsewhere')?.pullRequestOutcome).toBeNull();
  });

  it('[KG-3.5] credits the run whose branch a person opened the pull request from', async () => {
    // The run pushed its branch and could not open a pull request, so a person
    // did. The branch is the run's: freeBranch suffixes it per run.
    const branch = 'agent/eng-42-2';
    const manual = 'https://github.com/acme/api/pull/9';
    const { service, entries, runs } = build({
      runs: [
        // An older run that pushed the same name, since deleted and reused.
        run({
          id: 'run-older',
          served: ['b'],
          result: { branch },
          createdAt: new Date('2026-08-01T10:00:00Z'),
        }),
        run({ served: ['a'], result: { branch } }),
        // A run started after the pull request was opened.
        run({
          id: 'run-later',
          served: ['c'],
          result: { branch },
          createdAt: new Date('2026-09-20T10:00:00Z'),
        }),
      ],
      entries: [entry('a'), entry('b'), entry('c')],
    });
    const report = {
      workspaceId: WORKSPACE,
      url: manual,
      branch,
      repo: 'Acme/API',
      openedAt: new Date('2026-09-02T10:00:00Z'),
    };

    await expect(
      service.pullRequestChanged({ ...report, state: 'MERGED' }),
    ).resolves.toEqual({ runs: 1 });

    expect(runs.get(RUN)?.pullRequestOutcome).toBe('MERGED');
    expect(counts(entries.get('a'))).toEqual([1, 0]);
    expect(runs.get('run-older')?.pullRequestOutcome).toBeNull();
    expect(runs.get('run-later')?.pullRequestOutcome).toBeNull();
    expect(counts(entries.get('b'))).toEqual([0, 0]);
    expect(counts(entries.get('c'))).toEqual([0, 0]);
  });

  it('[KG-3.5] does not credit a branch of the same name in another repository, or a run with its own pull request', async () => {
    const branch = 'agent/eng-42';
    const { service, runs } = build({
      runs: [
        run({
          id: 'run-web',
          served: ['a'],
          config: { repoUrl: 'https://github.com/acme/web.git' },
          result: { branch },
        }),
        run({
          id: 'run-own-pr',
          served: ['a'],
          result: { branch, prUrl: 'https://github.com/acme/api/pull/3' },
        }),
      ],
      entries: [entry('a')],
    });

    await expect(
      service.pullRequestChanged({
        workspaceId: WORKSPACE,
        url: 'https://github.com/acme/api/pull/9',
        state: 'MERGED',
        branch,
        repo: 'acme/api',
      }),
    ).resolves.toEqual({ runs: 0 });
    expect(runs.get('run-web')?.pullRequestOutcome).toBeNull();
    expect(runs.get('run-own-pr')?.pullRequestOutcome).toBeNull();
  });

  it('[KG-3.5] records the outcome of a held-out run’s pull request, with no signal', async () => {
    const { service, runs, signals } = build({
      runs: [run({ served: [] })],
      entries: [],
    });

    await service.pullRequestChanged({
      workspaceId: WORKSPACE,
      url: PR,
      state: 'MERGED',
    });

    // Counted in the arm comparison's merge rate, attributed to no entry.
    expect(runs.get(RUN)?.pullRequestOutcome).toBe('MERGED');
    expect(signals).toEqual([]);
  });

  it('[KG-3.5] ignores a pull request no run opened', async () => {
    const { service, prisma } = build({ runs: [], entries: [] });

    await expect(
      service.pullRequestChanged({
        workspaceId: WORKSPACE,
        url: 'https://github.com/acme/api/pull/99',
        state: 'MERGED',
      }),
    ).resolves.toEqual({ runs: 0 });
    expect(prisma.agentRun.update).not.toHaveBeenCalled();
  });
});

describe('what places a path under an entry', () => {
  const shape = (overrides: Partial<Parameters<typeof isUnder>[0]> = {}) => ({
    id: 'e',
    scope: null as string | null,
    citations: [] as Array<{
      path: string | null;
      moduleRepo: { fullName: string } | null;
    }>,
    ...overrides,
  });

  it('[KG-3.4] a file it cites, in the run’s repository or one unknown', () => {
    const cited = shape({
      citations: [{ path: 'src/a.ts', moduleRepo: { fullName: 'Acme/API' } }],
    });

    expect(isUnder(cited, 'src/a.ts', 'acme/api')).toBe(true);
    expect(isUnder(cited, 'src/a.ts', null)).toBe(true);
    expect(isUnder(cited, 'src/a.ts', 'acme/web')).toBe(false);
    expect(isUnder(cited, 'src/a.tsx', 'acme/api')).toBe(false);
  });

  it('[KG-3.4] a path in or under the folder its scope names', () => {
    expect(
      isUnder(shape({ scope: 'apps/server' }), 'apps/server/a.ts', null),
    ).toBe(true);
    expect(
      isUnder(
        shape({ scope: './apps/server/**/*.ts' }),
        'apps/server/x/a.ts',
        null,
      ),
    ).toBe(true);
    expect(
      isUnder(shape({ scope: 'apps/server' }), 'apps/serverless/a.ts', null),
    ).toBe(false);
    // A scope that is only a pattern names no folder, so it places nothing.
    expect(isUnder(shape({ scope: '**/*.ts' }), 'apps/a.ts', null)).toBe(false);
    // A scope may name the repository first.
    expect(
      isUnder(shape({ scope: 'acme/api/src' }), 'src/a.ts', 'acme/api'),
    ).toBe(true);
  });

  it('[KG-3.4] reads the repository a run worked in from its remote', () => {
    expect(repoNameOf({ repoUrl: 'https://github.com/Acme/API.git' })).toBe(
      'acme/api',
    );
    expect(repoNameOf({ repoUrl: 'git@github.com:acme/api.git' })).toBe(
      'acme/api',
    );
    expect(repoNameOf({ repoUrl: 'https://github.com/acme/api/' })).toBe(
      'acme/api',
    );
    expect(repoNameOf({ repoPath: '/srv/checkouts/api' })).toBeNull();
    expect(repoNameOf(null)).toBeNull();
  });
});

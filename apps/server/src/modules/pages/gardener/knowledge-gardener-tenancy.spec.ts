/**
 * Tenancy for the records the gardener keeps, and for the trace of a run.
 *
 * Two of the five models have no workspace column: a relation joins two
 * entries, and a signal joins an entry and a run. The fake below applies the
 * nested filters the way the database does, so a row reaches a workspace
 * only when every row it joins is in that workspace.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { RoleEnum } from '@vantikhq/types';
import { PrismaService } from 'nestjs-prisma';

import { KnowledgeGardenerController } from './knowledge-gardener.controller';
import KnowledgeGardenerService from './knowledge-gardener.service';
import KnowledgeRecordsService from './knowledge-records.service';

const MINE = 'workspace-mine';
const THEIRS = 'workspace-theirs';

type Row = Record<string, unknown>;

/** True when a row passes a Prisma `where`, nested relations included. */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') {
      return (condition as Row[]).some((each) => matches(row, each));
    }

    const value = row[key];

    if (condition === undefined) {
      return true;
    }

    if (condition === null || typeof condition !== 'object') {
      return value === condition;
    }

    if (condition instanceof Date) {
      return (value as Date).getTime() === condition.getTime();
    }

    const operators = condition as Row;

    if ('gte' in operators || 'lte' in operators || 'lt' in operators) {
      const time = (value as Date).getTime();
      return (
        (!operators.gte || time >= (operators.gte as Date).getTime()) &&
        (!operators.lte || time <= (operators.lte as Date).getTime()) &&
        (!operators.lt || time < (operators.lt as Date).getTime())
      );
    }

    if ('in' in operators) {
      return (operators.in as unknown[]).includes(value);
    }

    if ('not' in operators) {
      return value !== operators.not;
    }

    // A relation: the joined row must pass the nested filter.
    return (
      value !== undefined && value !== null && matches(value as Row, operators)
    );
  });
}

function table(rows: Row[]) {
  const find = ({ where, take }: { where?: Row; take?: number }) =>
    rows.filter((row) => matches(row, where)).slice(0, take ?? rows.length);

  return {
    findMany: jest.fn(async (args: { where?: Row; take?: number }) =>
      find(args),
    ),
    findFirst: jest.fn(async (args: { where?: Row }) => find(args)[0] ?? null),
  };
}

const at = new Date('2026-09-20T10:00:00Z');
const entryMine = { id: 'entry-mine', workspaceId: MINE };
const entryMine2 = { id: 'entry-mine-2', workspaceId: MINE };
const entryTheirs = { id: 'entry-theirs', workspaceId: THEIRS };
const runMine = { id: 'run-mine', workspaceId: MINE };
const runTheirs = { id: 'run-theirs', workspaceId: THEIRS };

function buildPrisma() {
  return {
    pageEntryRelation: table([
      {
        id: 'rel-mine',
        createdAt: at,
        fromId: entryMine.id,
        toId: entryMine2.id,
        from: entryMine,
        to: entryMine2,
      },
      // One end in each workspace: neither may read it.
      {
        id: 'rel-across',
        createdAt: at,
        fromId: entryMine.id,
        toId: entryTheirs.id,
        from: entryMine,
        to: entryTheirs,
      },
      {
        id: 'rel-theirs',
        createdAt: at,
        fromId: entryTheirs.id,
        toId: entryTheirs.id,
        from: entryTheirs,
        to: entryTheirs,
      },
    ]),
    pageEntryUse: table([
      {
        id: 'use-mine',
        createdAt: at,
        workspaceId: MINE,
        entryId: entryMine.id,
        agentRunId: runMine.id,
        entry: entryMine,
      },
      {
        id: 'use-theirs',
        createdAt: at,
        workspaceId: THEIRS,
        entryId: entryTheirs.id,
        agentRunId: runTheirs.id,
        entry: entryTheirs,
      },
      // A use recorded in my workspace of an entry that is not mine.
      {
        id: 'use-crossed',
        createdAt: at,
        workspaceId: MINE,
        entryId: entryTheirs.id,
        agentRunId: runMine.id,
        entry: entryTheirs,
      },
    ]),
    pageEntrySignal: table([
      {
        id: 'sig-mine',
        createdAt: at,
        entryId: entryMine.id,
        agentRunId: runMine.id,
        entry: entryMine,
        agentRun: runMine,
      },
      {
        id: 'sig-run-theirs',
        createdAt: at,
        entryId: entryMine.id,
        agentRunId: runTheirs.id,
        entry: entryMine,
        agentRun: runTheirs,
      },
      {
        id: 'sig-entry-theirs',
        createdAt: at,
        entryId: entryTheirs.id,
        agentRunId: runMine.id,
        entry: entryTheirs,
        agentRun: runMine,
      },
    ]),
    pageEntryMaintenance: table([
      {
        id: 'maint-mine',
        createdAt: at,
        workspaceId: MINE,
        entryId: entryMine.id,
        entry: entryMine,
      },
      {
        id: 'maint-theirs',
        createdAt: at,
        workspaceId: THEIRS,
        entryId: entryTheirs.id,
        entry: entryTheirs,
      },
    ]),
    knowledgeBackoffChange: table([
      { id: 'backoff-mine', createdAt: at, workspaceId: MINE },
      {
        id: 'backoff-mine-old',
        createdAt: new Date('2026-09-01T00:00:00Z'),
        workspaceId: MINE,
      },
      { id: 'backoff-theirs', createdAt: at, workspaceId: THEIRS },
    ]),
    agentRun: table([
      { ...runMine, deleted: null },
      { ...runTheirs, deleted: null },
    ]),
  } as unknown as PrismaService;
}

const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id);

describe('reading the records the gardener keeps', () => {
  const records = new KnowledgeRecordsService(buildPrisma());

  it('reads a relation only when both of its entries are in the workspace', async () => {
    expect(ids(await records.relations(MINE, {}))).toEqual(['rel-mine']);
    expect(ids(await records.relations(THEIRS, {}))).toEqual(['rel-theirs']);
    expect(
      ids(await records.relations(MINE, { entryId: entryTheirs.id })),
    ).toEqual([]);
  });

  it('reads a use only when its entry is in the workspace too', async () => {
    expect(ids(await records.uses(MINE, {}))).toEqual(['use-mine']);
    expect(ids(await records.uses(THEIRS, {}))).toEqual(['use-theirs']);
  });

  it('reads a signal only when its entry and its run are in the workspace', async () => {
    expect(ids(await records.signals(MINE, {}))).toEqual(['sig-mine']);
    expect(ids(await records.signals(THEIRS, {}))).toEqual([]);
    expect(
      ids(await records.signals(MINE, { agentRunId: runTheirs.id })),
    ).toEqual([]);
  });

  it('reads the maintenance and the backoff of the workspace alone', async () => {
    expect(ids(await records.maintenance(MINE, {}))).toEqual(['maint-mine']);
    expect(
      ids(await records.maintenance(MINE, { entryId: entryTheirs.id })),
    ).toEqual([]);
    expect(ids(await records.backoff(MINE, {}))).toEqual([
      'backoff-mine',
      'backoff-mine-old',
    ]);
    expect(ids(await records.backoff(THEIRS, {}))).toEqual(['backoff-theirs']);
  });

  it('keeps to the date and the limit it is given', async () => {
    expect(
      ids(await records.backoff(MINE, { since: '2026-09-10T00:00:00Z' })),
    ).toEqual(['backoff-mine']);
    expect(ids(await records.backoff(MINE, { limit: 1 }))).toHaveLength(1);
  });
});

describe('the trace of a run', () => {
  it('reports a run in another workspace as not found', async () => {
    const gardener = new KnowledgeGardenerService(
      buildPrisma(),
      {} as never,
      {} as never,
    );

    // Not forbidden: a foreign run and one that does not exist look the same.
    await expect(gardener.trace(MINE, runTheirs.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('who can read what the gardener does', () => {
  it('refuses an agent every route', async () => {
    const records = { backoff: jest.fn() };
    const controller = new KnowledgeGardenerController(
      records as never,
      {} as never,
      buildPrisma(),
    );

    await expect(
      controller.backoff(MINE, 'agent-user', RoleEnum.AGENT, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(records.backoff).not.toHaveBeenCalled();
  });
});

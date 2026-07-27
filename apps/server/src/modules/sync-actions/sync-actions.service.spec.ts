/**
 * Bootstrap must not resurrect deleted records.
 *
 * Regression cover for undeletable issues. A soft delete leaves two sync
 * actions for the same modelId — the original 'I' and a later 'D' — because
 * `upsertSyncAction` keys on modelId+action. `getBootstrap` deduplicated with
 * `distinct: ['modelId']` in *ascending* sequence order, which keeps the
 * oldest row per model, so the 'D' was thrown away and the deleted record went
 * back to the client as an insert. The client then showed a row the server
 * considers gone, and every write against it 404'd at WorkspaceResourceGuard,
 * which matches only `deleted: null`.
 */
import { PrismaService } from 'nestjs-prisma';

import SyncActionsService from './sync-actions.service';

const USER = 'user-1';
const WORKSPACE = 'workspace-1';

interface FakeSyncAction {
  modelId: string;
  modelName: string;
  action: string;
  sequenceId: bigint;
  workspaceId: string;
  [field: string]: string | bigint;
}

/**
 * Stands in for Prisma's `distinct` + `orderBy`: rows are ordered first, then
 * the first row of each distinct group is kept. That interaction is the whole
 * bug, so the fake has to reproduce it rather than paper over it.
 */
interface FindManyArgs {
  orderBy: { sequenceId: 'asc' | 'desc' };
  distinct: string[];
}

function findMany(rows: FakeSyncAction[], args: FindManyArgs) {
  const direction = args.orderBy.sequenceId === 'desc' ? -1 : 1;
  const ordered = [...rows].sort(
    (a, b) => direction * Number(a.sequenceId - b.sequenceId),
  );

  const seen = new Set<string>();
  return ordered.filter((row) => {
    const key = args.distinct.map((field: string) => row[field]).join('|');
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function buildService(rows: FakeSyncAction[], liveIssueIds?: string[]) {
  // `undefined` keeps the old behaviour for the bootstrap tests: every issue
  // still exists. A list makes rows outside it physically gone, which is what
  // a hard delete leaves behind.
  const exists = (id: string) =>
    liveIssueIds === undefined || liveIssueIds.includes(id);

  const prisma = {
    syncAction: {
      findMany: jest.fn((args) => Promise.resolve(findMany(rows, args))),
      findFirst: jest.fn((args) => {
        // Two callers: `getLastSequenceId` wants the highest sequence, and
        // `workspaceOfDeleted` wants the workspace a modelId was announced in.
        const modelId = args?.where?.modelId;

        if (!modelId) {
          return Promise.resolve({ sequenceId: 30n });
        }

        return Promise.resolve(
          rows.find((row) => row.modelId === modelId) ?? null,
        );
      }),
      upsert: jest.fn(({ create }) => Promise.resolve(create)),
    },
    issue: {
      findUnique: jest.fn(({ where }) =>
        Promise.resolve(exists(where.id) ? { id: where.id } : null),
      ),
    },
    usersOnWorkspaces: {
      findUnique: jest.fn(() => Promise.resolve({ status: 'ACTIVE' })),
    },
  } as unknown as PrismaService;

  return new SyncActionsService(prisma);
}

const action = (
  modelId: string,
  action: string,
  sequenceId: bigint,
): FakeSyncAction => ({
  modelId,
  modelName: 'Issue',
  action,
  sequenceId,
  workspaceId: WORKSPACE,
});

describe('SyncActionsService.getBootstrap', () => {
  it('omits a record whose latest action is a delete', async () => {
    const service = buildService([
      action('issue-deleted', 'I', 10n),
      action('issue-deleted', 'D', 20n),
      action('issue-live', 'I', 15n),
    ]);

    const { syncActions } = await service.getBootstrap(
      'Issue',
      WORKSPACE,
      USER,
    );

    expect(syncActions.map((a: FakeSyncAction) => a.modelId)).toEqual([
      'issue-live',
    ]);
  });

  it('keeps a record that was updated after being created', async () => {
    const service = buildService([
      action('issue-live', 'I', 10n),
      action('issue-live', 'U', 20n),
    ]);

    const { syncActions } = await service.getBootstrap(
      'Issue',
      WORKSPACE,
      USER,
    );

    expect(syncActions).toHaveLength(1);
    expect(syncActions[0].modelId).toBe('issue-live');
  });

  it('returns records oldest first', async () => {
    const service = buildService([
      action('issue-new', 'I', 30n),
      action('issue-old', 'I', 10n),
      action('issue-mid', 'I', 20n),
    ]);

    const { syncActions } = await service.getBootstrap(
      'Issue',
      WORKSPACE,
      USER,
    );

    expect(syncActions.map((a: FakeSyncAction) => a.modelId)).toEqual([
      'issue-old',
      'issue-mid',
      'issue-new',
    ]);
  });
});

/**
 * A physically deleted record must still reach the client.
 *
 * Replication used to drop `delete` messages outright, on the grounds that the
 * app soft-deletes — true of the app's own write paths and of nothing else.
 * Cascades, retention jobs, event trimming and an operator fixing data by hand
 * all remove rows for real, and every one of them left the record in each
 * connected client's cache permanently: the only thing that evicts a cached
 * row is a delete action, and none was written.
 *
 * Two things have to hold for the delete to survive the trip. The workspace
 * has to be resolvable after the row is gone, and the delta has to carry an
 * action whose record no longer exists — which it used to drop, so a client
 * that missed the live event never heard about the deletion again.
 */
describe('deletes of records that are physically gone', () => {
  it('resolves the workspace from the sync log, not from the missing row', async () => {
    const service = buildService([action('issue-gone', 'I', 10n)], []);

    const result = await service.upsertSyncAction(
      '0/1F',
      'delete',
      'Issue' as never,
      'issue-gone',
    );

    expect(result?.workspaceId).toBe(WORKSPACE);
    expect(result?.action).toBe('D');
  });

  it('carries the id, which is all a client needs to evict it', async () => {
    const service = buildService([action('issue-gone', 'I', 10n)], []);

    const result = await service.upsertSyncAction(
      '0/1F',
      'delete',
      'Issue' as never,
      'issue-gone',
    );

    expect(result?.data).toEqual({ id: 'issue-gone' });
  });

  it('says nothing about a record no client was ever told about', async () => {
    // Never announced, so nobody has it cached and a delete action would be a
    // row nobody can act on.
    const service = buildService([], []);

    const result = await service.upsertSyncAction(
      '0/1F',
      'delete',
      'Issue' as never,
      'issue-never-seen',
    );

    expect(result).toBeUndefined();
  });

  it('keeps the delete in a delta even though the record cannot be read', async () => {
    const service = buildService(
      [action('issue-gone', 'I', 10n), action('issue-gone', 'D', 20n)],
      [],
    );

    const { syncActions } = await service.getDelta('Issue', 5n, WORKSPACE, USER);

    // The regression: dropping this leaves the row in the client's cache for
    // good, clickable and opening a page the server will 404.
    expect(syncActions).toHaveLength(1);
    expect(syncActions[0].action).toBe('D');
    expect(syncActions[0].data).toEqual({ id: 'issue-gone' });
  });

  it('still drops a non-delete whose record cannot be read', async () => {
    // An insert with no row behind it is a fault, not a message: sending it
    // would ask the client to store a record that does not exist.
    const service = buildService([action('issue-gone', 'I', 10n)], []);

    const { syncActions } = await service.getDelta('Issue', 5n, WORKSPACE, USER);

    expect(syncActions).toHaveLength(0);
  });
});

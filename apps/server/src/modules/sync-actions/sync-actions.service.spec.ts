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
function findMany(rows: FakeSyncAction[], args: any) {
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

function buildService(rows: FakeSyncAction[]) {
  const prisma = {
    syncAction: {
      findMany: jest.fn((args) => Promise.resolve(findMany(rows, args))),
      findFirst: jest.fn(() => Promise.resolve({ sequenceId: 30n })),
    },
    issue: {
      findUnique: jest.fn(({ where }) => Promise.resolve({ id: where.id })),
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

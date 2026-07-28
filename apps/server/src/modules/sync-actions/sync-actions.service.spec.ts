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
const TEAM_OWN = 'team-own';
const TEAM_OTHER = 'team-other';

interface FakeSyncAction {
  modelId: string;
  modelName: string;
  action: string;
  sequenceId: bigint;
  workspaceId: string;
  // Optional so that a hit off `getBootstrap` can be read as one of these. The
  // shared `SyncAction` type has no team, and the assertions below only ever
  // read `modelId` and `action` off the result.
  teamId?: string | null;
  [field: string]: string | bigint | null | undefined;
}

interface FakeWhere {
  OR?: Array<Record<string, unknown>>;
  sequenceId?: { gt: bigint };
}

/**
 * Stands in for the team clause that `syncActionTeamWhere` builds.
 *
 * A null team means no team owns the record, so it reaches every member of the
 * workspace. The fake honours that as the query does; a fake that ignored it
 * would let a test prove only that the fake agrees with itself.
 */
function matchesTeam(row: FakeSyncAction, where?: FakeWhere) {
  if (!where?.OR) {
    return true;
  }

  return where.OR.some((clause) =>
    clause.teamId === null
      ? row.teamId === null
      : (clause.teamId as { in: string[] }).in.includes(row.teamId as string),
  );
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

function buildService(
  rows: FakeSyncAction[],
  liveIssueIds?: string[],
  callerTeamIds: string[] = [TEAM_OWN, TEAM_OTHER],
) {
  // `undefined` keeps the old behaviour for the bootstrap tests: every issue
  // still exists. A list makes rows outside it physically gone, which is what
  // a hard delete leaves behind.
  const exists = (id: string) =>
    liveIssueIds === undefined || liveIssueIds.includes(id);

  const prisma = {
    syncAction: {
      findMany: jest.fn((args) => {
        // `getDelta` filters by sequence before ordering; without honouring
        // that here, a "client is already current" case would still be handed
        // rows and the test would be asserting against a fake, not the service.
        const after = args?.where?.sequenceId?.gt;
        const candidates = (
          after === undefined
            ? rows
            : rows.filter((row) => row.sequenceId > after)
        ).filter((row) => matchesTeam(row, args?.where));

        return Promise.resolve(findMany(candidates, args));
      }),
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
      // Two callers with two different `select`s: `resolveWorkspaceId` reads
      // the status, and `visibleTeamIds` reads the teams.
      findUnique: jest.fn(() =>
        Promise.resolve({ status: 'ACTIVE', teamIds: callerTeamIds }),
      ),
    },
  } as unknown as PrismaService;

  return new SyncActionsService(prisma);
}

const action = (
  modelId: string,
  action: string,
  sequenceId: bigint,
  teamId: string | null = TEAM_OWN,
): FakeSyncAction => ({
  modelId,
  modelName: 'Issue',
  action,
  sequenceId,
  workspaceId: WORKSPACE,
  teamId,
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

    const { syncActions } = await service.getDelta(
      'Issue',
      5n,
      WORKSPACE,
      USER,
    );

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

    const { syncActions } = await service.getDelta(
      'Issue',
      5n,
      WORKSPACE,
      USER,
    );

    expect(syncActions).toHaveLength(0);
  });
});

/**
 * A client cannot legitimately be ahead of the server.
 *
 * When it is, its history belongs to a database this one is not — a restore, a
 * workspace copied between environments, a sequence surviving a reset — and
 * every delta from that point is empty while the cache quietly stays wrong.
 * Answering "no changes" to a question with no true answer is the failure mode
 * worth refusing.
 */
describe('SyncActionsService.getDelta on a sequence it cannot serve', () => {
  it('asks the client to resync when its sequence is ahead of the log', async () => {
    const service = buildService([action('issue-1', 'I', 10n)]);

    const delta = await service.getDelta('Issue', 999n, WORKSPACE, USER);

    expect(delta.resync).toBe(true);
    expect(delta.syncActions).toEqual([]);
  });

  it('serves a delta normally for a sequence the log covers', async () => {
    const service = buildService([action('issue-1', 'I', 10n)]);

    const delta = await service.getDelta('Issue', 5n, WORKSPACE, USER);

    expect(delta.resync).toBeUndefined();
    expect(delta.syncActions).toHaveLength(1);
  });

  it('serves an empty delta rather than a resync when the client is current', async () => {
    // Caught up is the common case and must stay cheap: nothing to send, and
    // no reason to make anyone re-download a workspace.
    const service = buildService([action('issue-1', 'I', 10n)]);

    const delta = await service.getDelta('Issue', 30n, WORKSPACE, USER);

    expect(delta.resync).toBeUndefined();
    expect(delta.syncActions).toEqual([]);
  });
});

/**
 * The boundary that a bootstrap draws.
 *
 * A team is a visibility boundary (ENG-79). It has to hold here, because this
 * query and `getDelta` are what fill a client's IndexedDB — a screen that
 * filters what it draws hides nothing, since the record is already on the
 * machine.
 *
 * This file used to pin the opposite. Until ENG-79 the query named only the
 * workspace, and the tests below said so, on the reasoning that a product page
 * rolls issues up across teams and can be no narrower than the query behind it.
 * The decision went the other way: a product page shows the issues of that
 * module which the viewer may see, and no others.
 */
describe('SyncActionsService.getBootstrap scope', () => {
  it('reads only the workspace it was asked for', async () => {
    const service = buildService([action('issue-live', 'I', 10n)]);

    await service.getBootstrap('Issue', WORKSPACE, USER);

    const calls = (
      (service as unknown as { prisma: PrismaService }).prisma.syncAction
        .findMany as jest.Mock
    ).mock.calls;

    expect(calls[0][0].where.workspaceId).toBe(WORKSPACE);
  });

  it('names the teams of the caller in the query', async () => {
    const service = buildService([action('issue-live', 'I', 10n)], undefined, [
      TEAM_OWN,
    ]);

    await service.getBootstrap('Issue', WORKSPACE, USER);

    const where = (
      (service as unknown as { prisma: PrismaService }).prisma.syncAction
        .findMany as jest.Mock
    ).mock.calls[0][0].where;

    expect(where.OR).toEqual([
      { teamId: null },
      { teamId: { in: [TEAM_OWN] } },
    ]);
  });

  it('gives a non-member nothing of another team', async () => {
    const service = buildService(
      [
        action('issue-mine', 'I', 10n, TEAM_OWN),
        action('issue-theirs', 'I', 20n, TEAM_OTHER),
      ],
      undefined,
      [TEAM_OWN],
    );

    const { syncActions } = await service.getBootstrap(
      'Issue',
      WORKSPACE,
      USER,
    );

    expect(syncActions.map((a: FakeSyncAction) => a.modelId)).toEqual([
      'issue-mine',
    ]);
  });

  it('gives a member of no team nothing that a team owns', async () => {
    const service = buildService(
      [action('issue-mine', 'I', 10n, TEAM_OWN)],
      undefined,
      [],
    );

    const { syncActions } = await service.getBootstrap(
      'Issue',
      WORKSPACE,
      USER,
    );

    expect(syncActions).toEqual([]);
  });

  /**
   * A Label, a Page and a Project belong to the workspace and not to a team.
   * The boundary must not swallow them, or a member of one team would lose the
   * labels that every team shares.
   */
  it('still gives everyone the records that no team owns', async () => {
    const service = buildService(
      [action('label-1', 'I', 10n, null)],
      undefined,
      [],
    );

    const { syncActions } = await service.getBootstrap(
      'Issue',
      WORKSPACE,
      USER,
    );

    expect(syncActions.map((a: FakeSyncAction) => a.modelId)).toEqual([
      'label-1',
    ]);
  });
});

describe('SyncActionsService.getDelta scope', () => {
  it('gives a non-member no change to another team’s issue', async () => {
    const service = buildService(
      [
        action('issue-mine', 'U', 10n, TEAM_OWN),
        action('issue-theirs', 'U', 20n, TEAM_OTHER),
      ],
      undefined,
      [TEAM_OWN],
    );

    const { syncActions } = await service.getDelta(
      'Issue',
      5n,
      WORKSPACE,
      USER,
    );

    expect(syncActions.map((a) => a.modelId)).toEqual(['issue-mine']);
  });

  /**
   * An issue that moves to another team leaves the client that held it. The
   * announcement is upserted with the new team, so the next delta no longer
   * matches for the old team — and the issue stops arriving there.
   */
  it('follows an issue that moved to a team the caller cannot see', async () => {
    const service = buildService(
      [action('issue-moved', 'U', 20n, TEAM_OTHER)],
      undefined,
      [TEAM_OWN],
    );

    const { syncActions } = await service.getDelta(
      'Issue',
      5n,
      WORKSPACE,
      USER,
    );

    expect(syncActions).toEqual([]);
  });
});

/**
 * The team of an announcement.
 *
 * `upsertSyncAction` writes it, and a physical delete recovers it from the log
 * exactly as the workspace is recovered — the row is gone, so the announcement
 * that named it while it existed is the last thing that knows.
 */
describe('the team on a sync action', () => {
  it('recovers the team of a record that is physically gone', async () => {
    const service = buildService(
      [action('issue-gone', 'I', 10n, TEAM_OTHER)],
      [],
    );

    const result = await service.upsertSyncAction(
      '0/1F',
      'delete',
      'Issue' as never,
      'issue-gone',
    );

    // Without this the delete would carry no team, land in the workspace room,
    // and reach every member — which is the leak the boundary exists to stop.
    expect(result?.teamId).toBe(TEAM_OTHER);
  });
});

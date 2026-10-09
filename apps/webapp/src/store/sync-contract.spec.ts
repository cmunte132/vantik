import { isDeepStrictEqual } from 'node:util';

import { describe, expect, it } from 'vitest';

import type { SyncActionRecord } from 'common/types';
import { modelStoreMap, SAVE_HANDLERS } from 'common/wrappers/socket-data-util';

import { createStoreContext } from './global-context-provider';
import { getPrismaModel } from './test-support/prisma-schema';
import {
  storeHolds,
  syncRecord,
  syncedStore,
} from './test-support/synced-store';

/**
 * What the server syncs has to survive the client: the save handler, the local
 * database and the store, and then a reload from that database. Each hop has
 * dropped data before, silently, with the screen simply showing less:
 *
 * - A cycle's `status` never reached the client, because neither the save
 *   handler nor the store model knew the column existed.
 * - An agent run event lost its `data` on the way into the store.
 * - A delete carrying only an id threw in a save handler, so the record stayed
 *   on screen.
 *
 * Every model with a save handler runs through the same checks here, with a
 * record built from schema.prisma, so a new column or a new model is covered
 * without anyone remembering to add it.
 */

const MODELS_SAVED = Object.keys(SAVE_HANDLERS);

const NOT_READ = 'nothing in the webapp reads it';

/**
 * Columns a save handler does not keep, and why. A column added to the schema
 * and not kept fails the second test below until it is either kept or listed
 * here, which is the point: dropping a column should be a decision.
 */
const NOT_KEPT: Record<string, Record<string, string>> = {
  Team: { icon: NOT_READ },
  AgentSession: { terminalSeenAt: NOT_READ },
  Workspace: { icon: NOT_READ },
  UsersOnWorkspaces: { externalAccountMappings: NOT_READ, joinedAt: NOT_READ },
  Issue: {
    subIssueSortOrder: NOT_READ,
    isBidirectional: NOT_READ,
    updatedById: NOT_READ,
    attachments: NOT_READ,
    issueSuggestionId: NOT_READ,
  },
  IssueHistory: {
    fromTeamId: NOT_READ,
    toTeamId: NOT_READ,
    fromProjectId: NOT_READ,
    toProjectId: NOT_READ,
    fromProjectMilestoneId: NOT_READ,
    toProjectMilestoneId: NOT_READ,
    fromCycleId: NOT_READ,
    toCycleId: NOT_READ,
  },
  IssueComment: {
    updatedById: NOT_READ,
    reactionsData: NOT_READ,
    attachments: NOT_READ,
  },
  ChecklistItem: { updatedById: NOT_READ },
  AgentRun: {
    previousRunId: NOT_READ,
    leaseExpiresAt: 'executor bookkeeping',
    claimedAt: 'executor bookkeeping',
    contextPack: 'executor bookkeeping, and large',
    configHash: 'executor bookkeeping',
    baseCommit: NOT_READ,
    // Read in aggregate, per arm, from /agent_runs/meta/knowledge-arms.
    knowledgeArm: 'read per arm, through the knowledge arms endpoint',
    pullRequestOutcome: 'read per arm, through the knowledge arms endpoint',
    pullRequestClosedAt: NOT_READ,
  },
  Page: {
    // A generated page's sections are rendered into its body, which is kept.
    sections: 'rendered into the body, which is kept',
    citedEntryIds: NOT_READ,
    watermark: 'refresh bookkeeping',
    evidenceHash: 'refresh bookkeeping',
    refreshedAt: 'refresh bookkeeping',
  },
  PageEntry: {
    sourceTokenId: NOT_READ,
    helpfulCount: NOT_READ,
    harmfulCount: NOT_READ,
    contentHash: 'triage bookkeeping',
    corroborationCount: NOT_READ,
    // The webapp gets the provisional state from the status column.
    provisionalSince: NOT_READ,
  },
  IntegrationAccount: {
    integrationConfiguration: NOT_READ,
    isActive: NOT_READ,
  },
  LinkedIssue: { sync: NOT_READ, updatedById: NOT_READ },
  IssueRelation: { metadata: NOT_READ, deletedById: NOT_READ },
  Notification: { snoozedUntil: NOT_READ },
  IssueSuggestion: { metadata: NOT_READ },
  Project: { capabilityIds: NOT_READ },
  Module: {
    verification:
      'the verification page fetches it from the API instead (modules/product-axis/verification.tsx)',
  },
  Template: { createdById: NOT_READ },
  Support: { slaStatus: NOT_READ },
};

/** Columns a save handler keeps under another name. */
const RENAMED: Record<string, Record<string, string>> = {
  IssueHistory: { sourceMetaData: 'sourceMetadata' },
};

/**
 * Json columns whose store model has a shape of its own, where the generic
 * `{ column: 'json' }` the record builder writes would be rejected for the
 * wrong reason.
 */
const REALISTIC: Record<string, Record<string, unknown>> = {
  IssueHistory: {
    relationChanges: {
      type: 'BLOCKS',
      relatedIssueId: 'relatedIssueId-1',
      issueId: 'issueId-1',
    },
  },
};

/**
 * Stores that load one scope at a time from the local database, and the column
 * of the record that names the scope. The rest load everything.
 */
const RELOAD: Record<
  string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (store: any, data: Record<string, any>) => Promise<unknown>
> = {
  Workspace: (store, data) => store.load(data.id),
  UsersOnWorkspaces: (store, data) => store.load(data.workspaceId),
  IssueComment: (store, data) => store.load(data.issueId),
  IssueHistory: (store, data) => store.load(data.issueId),
  ChecklistItem: (store, data) => store.load(data.issueId),
  LinkedIssue: (store, data) => store.load(data.issueId),
  PageEntry: (store, data) => store.load(data.pageId),
  AgentRunEvent: (store, data) => store.loadEvents(data.runId),
};

/**
 * Stores that keep a record after its delete arrives. The row still leaves the
 * local database, so it is gone after a reload.
 */
const KEPT_AFTER_DELETE: Record<string, string> = {
  Workspace:
    'the store holds the one workspace that is open, and a delete of it does not clear it',
};

function insert(model: string, options: { nulls?: boolean } = {}) {
  return syncRecord(model, 'I', { ...options, data: REALISTIC[model] });
}

/**
 * A handler may store a Json column as a string, and does for several. That is
 * the same value, so it is compared parsed.
 */
function sameValue(stored: unknown, sent: unknown): boolean {
  if (typeof stored === 'string' && sent !== null && typeof sent === 'object') {
    try {
      return isDeepStrictEqual(JSON.parse(stored), sent);
    } catch {
      return false;
    }
  }

  return isDeepStrictEqual(stored, sent);
}

describe.each(MODELS_SAVED)('a synced %s', (model) => {
  it('reaches the local database and the store', async () => {
    const client = syncedStore();
    const record = insert(model);

    await client.apply(record);

    expect(await client.row(model, record.modelId)).toBeDefined();
    expect(storeHolds(client.storeFor(model), record.modelId)).toBe(true);
  });

  it('keeps every column, or is listed as dropping it on purpose', async () => {
    const client = syncedStore();
    const record = insert(model);

    await client.apply(record);
    const row = await client.row(model, record.modelId);

    const dropped = getPrismaModel(model)
      .fields.map((field) => field.name)
      // A deleted record arrives as a delete and leaves, so no kept row is
      // ever deleted and the column has nothing to say.
      .filter((column) => column !== 'deleted')
      .filter((column) => !(column in (NOT_KEPT[model] ?? {})))
      .filter((column) => {
        const keptAs = RENAMED[model]?.[column] ?? column;
        return !sameValue(row?.[keptAs], record.data[column]);
      });

    expect(
      dropped,
      `The ${model} save handler does not keep these columns from the ` +
        `server. Map them in the handler, or add them to NOT_KEPT with the ` +
        `reason the webapp does without them.`,
    ).toEqual([]);
  });

  it('is kept when every nullable column is null', async () => {
    const client = syncedStore();
    const record = insert(model, { nulls: true });

    await client.apply(record);

    expect(await client.row(model, record.modelId)).toBeDefined();
    expect(storeHolds(client.storeFor(model), record.modelId)).toBe(true);
  });

  it('takes an update', async () => {
    const client = syncedStore();
    const record = insert(model);
    await client.apply(record);

    const updatedAt = '2026-02-03T04:05:06.000Z';
    const update: SyncActionRecord = {
      ...record,
      action: 'U' as SyncActionRecord['action'],
      data: { ...record.data, updatedAt },
    };
    await client.apply(update);

    const row = await client.row(model, record.modelId);
    if ('updatedAt' in record.data && !NOT_KEPT[model]?.updatedAt) {
      expect(row?.updatedAt).toBe(updatedAt);
    }
    expect(storeHolds(client.storeFor(model), record.modelId)).toBe(true);
  });

  it('comes back from the local database after a reload', async () => {
    const client = syncedStore();
    const record = insert(model);
    await client.apply(record);

    // A reload builds new stores over the database the last session left.
    const fresh =
      modelStoreMap(createStoreContext())[
        model as keyof ReturnType<typeof modelStoreMap>
      ];
    await (RELOAD[model]?.(fresh, record.data) ?? fresh.load());

    expect(storeHolds(fresh, record.modelId)).toBe(true);
  });

  it('is removed by a delete that carries only its id', async () => {
    const client = syncedStore();
    const record = insert(model);
    await client.apply(record);

    // A physically deleted row is gone by the time the server reads it, so
    // the delete it sends carries the id and nothing else.
    await client.apply({
      ...record,
      action: 'D' as SyncActionRecord['action'],
      data: { id: record.modelId },
    });

    expect(await client.row(model, record.modelId)).toBeUndefined();
    if (!(model in KEPT_AFTER_DELETE)) {
      expect(storeHolds(client.storeFor(model), record.modelId)).toBe(false);
    }
  });
});

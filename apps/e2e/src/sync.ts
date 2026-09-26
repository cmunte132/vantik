import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';

// The list the webapp asks for, taken from the webapp itself: a model the
// client names and the server does not know fails every bootstrap.
import { MODELS } from '../../webapp/src/store/models';

/**
 * The sync API, as the webapp calls it. A bootstrap is the world as it stands
 * for the caller; a delta is every change after a cursor. What these return is
 * what the client holds, so they are also where a visibility bug shows: a
 * record that is in here is on that person's disk.
 */

export const WEBAPP_MODELS: string[] = Object.values(MODELS);

export interface SyncRecord {
  modelName: string;
  modelId: string;
  action: 'I' | 'U' | 'D';
  sequenceId: string;
  workspaceId: string;
  teamId: string | null;
  // The row as the database holds it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
}

export interface SyncResponse {
  syncActions: SyncRecord[];
  lastSequenceId: string;
  resync?: boolean;
}

async function ok(response: APIResponse, what: string): Promise<SyncResponse> {
  expect(
    response,
    `${what} failed: ${response.status()} ${await response.text()}`,
  ).toBeOK();
  return response.json();
}

export async function bootstrap(
  api: APIRequestContext,
  models: string[] = WEBAPP_MODELS,
): Promise<SyncResponse> {
  return ok(
    await api.get('/v1/sync_actions/bootstrap', {
      params: { modelNames: models.join(',') },
    }),
    'bootstrap',
  );
}

export async function delta(
  api: APIRequestContext,
  since: string,
  models: string[] = WEBAPP_MODELS,
): Promise<SyncResponse> {
  return ok(
    await api.get('/v1/sync_actions/delta', {
      params: { modelNames: models.join(','), lastSequenceId: since },
    }),
    'delta',
  );
}

/**
 * Where the caller's workspace log stands now. Take it before a write, and the
 * write is in every delta from it.
 */
export async function cursor(api: APIRequestContext): Promise<string> {
  return (await bootstrap(api, ['Workspace'])).lastSequenceId;
}

/**
 * Waits for the change to reach the caller's delta, and returns it. Changes
 * reach the log through Postgres replication, a moment after the write
 * returns, so nothing is there to read straight away.
 */
export async function synced(
  api: APIRequestContext,
  since: string,
  model: string,
  modelId: string,
  action: SyncRecord['action'],
): Promise<SyncRecord> {
  let found: SyncRecord | undefined;

  await expect
    .poll(
      async () => {
        found = (await delta(api, since, [model])).syncActions.find(
          (record) => record.modelId === modelId && record.action === action,
        );
        return found !== undefined;
      },
      {
        message: `${model} ${modelId} never reached the delta as ${action}`,
        timeout: 20_000,
        intervals: [100, 250, 500, 1_000],
      },
    )
    .toBe(true);

  return found!;
}

/** The ids a bootstrap hands the caller for one model. */
export async function bootstrapIds(
  api: APIRequestContext,
  model: string,
): Promise<string[]> {
  return (await bootstrap(api, [model])).syncActions.map(
    (record) => record.modelId,
  );
}

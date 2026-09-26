import { ActionTypesEnum } from '@vantikhq/types';

/** The queue a connected integration's behaviour runs on. */
export const INTEGRATION_EVENTS_QUEUE = 'integration-events';

/** Hand one event to one connected account's plugin. */
export const DISPATCH_JOB = 'dispatch';

/** The events a plugin is handed after it is connected. */
export type IntegrationEvent =
  | ActionTypesEnum.ON_CREATE
  | ActionTypesEnum.ON_UPDATE
  | ActionTypesEnum.SOURCE_WEBHOOK;

/**
 * What the processor is given: plain data and ids, never a token.
 *
 * The account is reloaded when the job runs rather than carried here, so a
 * job that waited in the queue across a disconnect finds the account gone and
 * does nothing, and a credential never sits in Redis.
 */
export interface IntegrationEventJob {
  /** The integration, and the directory its code lives in. */
  slug: string;
  workspaceId: string;
  integrationAccountId: string;
  event: IntegrationEvent;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: Record<string, any>;
}

/** A row that replication saw change, in a table plugins may watch. */
export interface RecordChange {
  modelName: string;
  modelId: string;
  /** The replication tag: `insert`, `update`, or `delete` for a soft delete. */
  tag: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  changedData: Record<string, any>;
  workspaceId: string;
  /** The log sequence number, which names this change among the replicas. */
  lsn: string;
}

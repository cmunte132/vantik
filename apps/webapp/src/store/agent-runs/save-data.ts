import type { AgentRunsStoreType } from './store';

import type { SyncActionRecord } from 'common/types';

import { vantikDatabase } from 'store/database';

export async function saveAgentRunData(
  data: SyncActionRecord[],
  agentRunsStore: AgentRunsStoreType,
) {
  await Promise.all(
    data.map(async (record: SyncActionRecord) => {
      const agentRun = {
        id: record.data.id,
        createdAt: record.data.createdAt,
        updatedAt: record.data.updatedAt,

        workspaceId: record.data.workspaceId,
        issueId: record.data.issueId,
        agentUserId: record.data.agentUserId,
        createdById: record.data.createdById,

        executor: record.data.executor,
        status: record.data.status,
        attempt: record.data.attempt,

        startedAt: record.data.startedAt,
        finishedAt: record.data.finishedAt,

        summary: record.data.summary,
        error: record.data.error,
        failure: record.data.failure,

        result: record.data.result,
        config: record.data.config,
        harnessVersion: record.data.harnessVersion,
        modelId: record.data.modelId,
        iterationCount: record.data.iterationCount,
        phaseTimings: record.data.phaseTimings,
      };

      switch (record.action) {
        case 'I':
        case 'U': {
          await vantikDatabase.agentRuns.put(agentRun);
          return (
            agentRunsStore &&
            (await agentRunsStore.update(agentRun, record.data.id))
          );
        }

        case 'D': {
          await vantikDatabase.agentRuns.delete(record.data.id);
          return (
            agentRunsStore &&
            (await agentRunsStore.deleteById(record.data.id))
          );
        }
      }
    }),
  );
}

export async function saveAgentRunEventData(
  data: SyncActionRecord[],
  agentRunsStore: AgentRunsStoreType,
) {
  await Promise.all(
    data.map(async (record: SyncActionRecord) => {
      const event = {
        id: record.data.id,
        createdAt: record.data.createdAt,
        at: record.data.at,
        level: record.data.level,
        message: record.data.message,
        phase: record.data.phase,
        // What the step was. Dropped here, the timeline has only strings to
        // draw from and every step looks the same as every other one.
        data: record.data.data ?? null,
        runId: record.data.runId,
      };

      switch (record.action) {
        case 'I':
        case 'U': {
          await vantikDatabase.agentRunEvents.put(event);
          return (
            agentRunsStore &&
            (await agentRunsStore.updateEvent(event, record.data.id))
          );
        }

        case 'D': {
          await vantikDatabase.agentRunEvents.delete(record.data.id);
          return (
            agentRunsStore &&
            (await agentRunsStore.deleteEventById(record.data.id))
          );
        }
      }
    }),
  );
}

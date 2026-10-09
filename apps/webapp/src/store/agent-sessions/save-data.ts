import type { AgentSessionsStoreType } from './store';

import type { SyncActionRecord } from 'common/types';

import { vantikDatabase } from 'store/database';

export async function saveAgentSessionData(
  data: SyncActionRecord[],
  agentSessionsStore: AgentSessionsStoreType,
) {
  await Promise.all(
    data.map(async (record: SyncActionRecord) => {
      const agentSession = {
        id: record.data.id,
        createdAt: record.data.createdAt,
        updatedAt: record.data.updatedAt,

        workspaceId: record.data.workspaceId,
        issueId: record.data.issueId,
        actorUserId: record.data.actorUserId,

        externalId: record.data.externalId,
        harness: record.data.harness,
        location: record.data.location,
        channel: record.data.channel,

        driver: record.data.driver,
        driverLeaseExpiresAt: record.data.driverLeaseExpiresAt,

        parentSessionId: record.data.parentSessionId,
        agentRunId: record.data.agentRunId,

        startedAt: record.data.startedAt,
        lastActiveAt: record.data.lastActiveAt,
        endedAt: record.data.endedAt,
      };

      switch (record.action) {
        case 'I':
        case 'U': {
          await vantikDatabase.agentSessions.put(agentSession);
          return (
            agentSessionsStore &&
            (await agentSessionsStore.update(agentSession, record.data.id))
          );
        }

        case 'D': {
          await vantikDatabase.agentSessions.delete(record.data.id);
          return (
            agentSessionsStore &&
            (await agentSessionsStore.deleteById(record.data.id))
          );
        }
      }
    }),
  );
}

import type { AgentQuestionsStoreType } from './store';

import type { SyncActionRecord } from 'common/types';

import { vantikDatabase } from 'store/database';

export async function saveAgentQuestionData(
  data: SyncActionRecord[],
  agentQuestionsStore: AgentQuestionsStoreType,
) {
  await Promise.all(
    data.map(async (record: SyncActionRecord) => {
      const agentQuestion = {
        id: record.data.id,
        createdAt: record.data.createdAt,
        updatedAt: record.data.updatedAt,

        workspaceId: record.data.workspaceId,
        issueId: record.data.issueId,
        agentRunId: record.data.agentRunId,
        agentSessionId: record.data.agentSessionId,

        externalId: record.data.externalId,
        source: record.data.source,
        questions: record.data.questions,

        status: record.data.status,
        answers: record.data.answers,
        answeredById: record.data.answeredById,
        answeredAt: record.data.answeredAt,

        assigneeId: record.data.assigneeId,
        expiresAt: record.data.expiresAt,
        deliveredAt: record.data.deliveredAt,
      };

      switch (record.action) {
        case 'I':
        case 'U': {
          await vantikDatabase.agentQuestions.put(agentQuestion);
          return (
            agentQuestionsStore &&
            (await agentQuestionsStore.update(agentQuestion, record.data.id))
          );
        }

        case 'D': {
          await vantikDatabase.agentQuestions.delete(record.data.id);
          return (
            agentQuestionsStore &&
            (await agentQuestionsStore.deleteById(record.data.id))
          );
        }
      }
    }),
  );
}

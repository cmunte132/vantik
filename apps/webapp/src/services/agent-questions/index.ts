import type { AgentQuestionAnswer, AgentQuestionStatus } from '@vantikhq/types';

import { ajaxPost, mutationHook } from 'services/utils';

export interface AnswerAgentQuestionParams {
  agentQuestionId: string;
  answers: AgentQuestionAnswer[];
}

/** The row after the answer, in the shape the sync log carries it. */
export interface AnsweredAgentQuestion {
  id: string;
  status: AgentQuestionStatus;
  answers: AgentQuestionAnswer[] | null;
  answeredById: string | null;
  answeredAt: string | null;
}

export function answerAgentQuestion({
  agentQuestionId,
  answers,
}: AnswerAgentQuestionParams): Promise<AnsweredAgentQuestion> {
  return ajaxPost({
    url: `/api/v1/agent_questions/${agentQuestionId}/answer`,
    data: { answers },
  });
}

// The server's refusals are written to be read ("Somebody else answered this
// question first"), so they reach the screen as they are.
export const useAnswerAgentQuestionMutation = mutationHook(
  answerAgentQuestion,
  { fallback: 'Could not send the answer.' },
);

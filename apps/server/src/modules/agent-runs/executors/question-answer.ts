import type { AgentQuestion } from '@prisma/client';
import {
  type AgentQuestionAnswer,
  type AgentQuestionItem,
  type ConnectorRunAnswer,
  formatAgentAnswers,
} from '@vantikhq/types';

/**
 * The end of a question, as the agent's machine gets it. A local run gets it
 * as the `run.answer` message. A hosted run gets it as the JSON file that the
 * `ask_person` tool reads, with the same fields.
 */
/** The end of a question that Vantik refused. The agent goes on alone. */
export function refusalMessage(
  runId: string,
  questionId: string,
  reason: string,
): ConnectorRunAnswer {
  return {
    runId,
    questionId,
    source: 'tool',
    status: 'cancelled',
    answers: [],
    text: '',
    reason: reason.slice(0, 200),
  };
}

export function answerMessage(question: AgentQuestion): ConnectorRunAnswer {
  const items = question.questions as unknown as AgentQuestionItem[];
  const answers = (question.answers ?? []) as unknown as AgentQuestionAnswer[];

  return {
    runId: question.agentRunId ?? '',
    questionId: question.externalId,
    source: question.source === 'omp_dialog' ? 'omp_dialog' : 'tool',
    status:
      question.status === 'ANSWERED'
        ? 'answered'
        : question.status === 'EXPIRED'
          ? 'expired'
          : 'cancelled',
    answers,
    text:
      question.status === 'ANSWERED' ? formatAgentAnswers(items, answers) : '',
  };
}

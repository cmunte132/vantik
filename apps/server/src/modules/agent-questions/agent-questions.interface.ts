/** The queue that expires questions nobody answered. */
export const AGENT_QUESTIONS_QUEUE = 'agent-questions';
export const AGENT_QUESTION_EXPIRY_JOB = 'expireAgentQuestions';
export const AGENT_QUESTION_EXPIRY_JOB_ID = 'agent-question-expiry';

/**
 * How often the sweep looks for expired questions. A cron expression has a
 * minute as its finest step, which is fine: the wait is measured in minutes.
 */
export const AGENT_QUESTION_EXPIRY_CRON =
  process.env.AGENT_QUESTION_EXPIRY_CRON ?? '* * * * *';

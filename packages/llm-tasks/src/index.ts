import { citationJudge } from './citation-judge';
import { pageRefresh } from './page-refresh';
import { type LLMTask } from './task';
import { triageAccept, triagePair } from './triage';

export * from './citation-judge';
export * from './evidence';
export * from './json';
export * from './lines';
export * from './page-refresh';
export * from './redact';
export * from './relation-guard';
export * from './task';
export * from './triage';

/** Every task in this package, by purpose. */
export const LLM_TASKS: Record<string, LLMTask<never, unknown>> = {
  [triagePair.purpose]: triagePair,
  [triageAccept.purpose]: triageAccept,
  [citationJudge.purpose]: citationJudge,
  [pageRefresh.purpose]: pageRefresh,
};

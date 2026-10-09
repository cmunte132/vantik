/* eslint-disable @typescript-eslint/no-explicit-any */
import * as React from 'react';

import { useContextStore } from 'store/global-context-provider';
import { UserContext } from 'store/user-context';

/**
 * The agent questions that wait for a person, for the whole workspace.
 *
 * `mine` are the ones for the person who started the run. Anyone who can see
 * the issue may answer, so `others` are shown too, after `mine`. An open
 * question past its time stays out: the server expires it within the minute,
 * and the agent has already gone on.
 *
 * Call it from an `observer` component, so it follows the store.
 */
export function useOpenQuestions(now = Date.now()) {
  const { agentQuestionsStore } = useContextStore();
  const currentUser = React.useContext(UserContext);

  const open: any[] = (agentQuestionsStore.openQuestions as any[]).filter(
    (question) => Date.parse(question.expiresAt) > now,
  );
  const mine = open.filter(
    (question) => question.assigneeId === currentUser?.id,
  );
  const others = open.filter(
    (question) => question.assigneeId !== currentUser?.id,
  );

  return { mine, others, all: [...mine, ...others], count: open.length };
}

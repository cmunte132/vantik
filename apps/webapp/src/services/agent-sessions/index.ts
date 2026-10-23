import { useQuery } from '@tanstack/react-query';

import { ajaxGet } from 'services/utils';

/**
 * The steps of a session that has no run: what a person did in their own
 * terminal. Read over REST, because nothing needs them live, and polled while
 * the view is open so a session that goes on shows its new steps.
 */
export function useSessionEvents(sessionId: string, enabled = true) {
  return useQuery({
    queryKey: ['agent-session-events', sessionId],
    queryFn: () =>
      ajaxGet({ url: `/api/v1/agent_sessions/${sessionId}/events` }),
    enabled,
    refetchInterval: 10_000,
  });
}

/**
 * What the session's usage cost, as the person's own record counts it. It is
 * read only while the activity view is open, one session at a time, so a list
 * of sessions does not ask for one usage record per row.
 */
export function useSessionUsage(sessionId: string, enabled = true) {
  return useQuery({
    queryKey: ['agent-session-usage', sessionId],
    queryFn: () =>
      ajaxGet({ url: `/api/v1/agent_sessions/${sessionId}/usage` }),
    enabled,
  });
}

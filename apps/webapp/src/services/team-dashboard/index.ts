import type {
  StateThreshold,
  StuckIssuesResponse,
  TeamDashboardMetrics,
} from '@vantikhq/types';

import { useQuery } from '@tanstack/react-query';

import { ajaxGet, ajaxPut, mutationHook } from 'services/utils';

export const TeamDashboardMetricsQuery = 'teamDashboardMetricsQuery';
export const TeamDashboardStuckQuery = 'teamDashboardStuckQuery';
export const TeamDashboardThresholdsQuery = 'teamDashboardThresholdsQuery';

/** The stuck list is the one view that changes while a person watches it. */
export const STUCK_REFETCH_MS = 5 * 60 * 1000;

function base(teamId: string) {
  return `/api/v1/teams/${teamId}/dashboard`;
}

export function getDashboardMetrics(teamId: string) {
  return ajaxGet<TeamDashboardMetrics>({ url: `${base(teamId)}/metrics` });
}

export function getStuckIssues(teamId: string) {
  return ajaxGet<StuckIssuesResponse>({ url: `${base(teamId)}/stuck` });
}

export function getThresholds(teamId: string) {
  return ajaxGet<StateThreshold[]>({ url: `${base(teamId)}/thresholds` });
}

export function useDashboardMetricsQuery(teamId?: string) {
  return useQuery({
    queryKey: [TeamDashboardMetricsQuery, teamId],
    queryFn: () => getDashboardMetrics(teamId),
    enabled: Boolean(teamId),
    retry: 1,
  });
}

export function useStuckIssuesQuery(teamId?: string) {
  return useQuery({
    queryKey: [TeamDashboardStuckQuery, teamId],
    queryFn: () => getStuckIssues(teamId),
    enabled: Boolean(teamId),
    refetchInterval: STUCK_REFETCH_MS,
    retry: 1,
  });
}

export function useThresholdsQuery(teamId?: string) {
  return useQuery({
    queryKey: [TeamDashboardThresholdsQuery, teamId],
    queryFn: () => getThresholds(teamId),
    enabled: Boolean(teamId),
    retry: 1,
  });
}

export interface UpdateThresholdOverridesParams {
  teamId: string;
  /** Map of stateId to hours. A null value clears the override. */
  overrides: Record<string, number | null>;
}

export function updateThresholdOverrides({
  teamId,
  overrides,
}: UpdateThresholdOverridesParams) {
  return ajaxPut<
    { overrides: Record<string, number | null> },
    StateThreshold[]
  >({
    url: `${base(teamId)}/thresholds/overrides`,
    data: { overrides },
  });
}

// A new threshold changes which issues count as stuck, so both answers go stale.
export const useUpdateThresholdOverridesMutation = mutationHook(
  updateThresholdOverrides,
  {
    invalidates: [TeamDashboardThresholdsQuery, TeamDashboardStuckQuery],
    fallback: 'Could not save the thresholds.',
  },
);

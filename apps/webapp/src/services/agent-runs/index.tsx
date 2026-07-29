/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMutation, useQuery } from '@tanstack/react-query';

import { ajaxGet, ajaxPost } from 'services/utils';

export interface DelegateParams {
  issueId: string;
  agentUserId?: string;
  executor?: string;
  guidance?: string;
  config?: { provider?: string; model?: string; thinking?: string };
  force?: boolean;
}

export function useDelegateMutation(options: {
  onSuccess?: (data: any) => void;
  onError?: (error: string) => void;
}) {
  return useMutation({
    mutationFn: (params: DelegateParams) =>
      ajaxPost({ url: '/api/v1/agent_runs', data: params }),
    onSuccess: options.onSuccess,
    onError: (error: unknown) => options.onError?.(messageOf(error)),
  });
}

/**
 * The server's own words where it has any.
 *
 * Its refusals are written to be read — "this issue already has a run in
 * progress", "this deployment has 2 executors; name one" — and each names a
 * different thing to do next. The ajax layer here is superagent, not axios: a
 * Nest error body arrives under `errors`, and only a body carrying `details`
 * ever reaches `message`. Reading the axios shape threw every one of those
 * sentences away and left the generic line below.
 */
function messageOf(error: unknown): string {
  const response = error as {
    errors?: { message?: string };
    message?: string;
  };

  return (
    response?.errors?.message ??
    response?.message ??
    'Could not delegate this issue.'
  );
}

export function useCancelRunMutation(options: { onSuccess?: () => void } = {}) {
  return useMutation({
    mutationFn: ({ runId, reason }: { runId: string; reason?: string }) =>
      ajaxPost({ url: `/api/v1/agent_runs/${runId}/cancel`, data: { reason } }),
    onSuccess: options.onSuccess,
  });
}

export function useRetryRunMutation(options: { onSuccess?: () => void } = {}) {
  return useMutation({
    mutationFn: ({ runId }: { runId: string }) =>
      ajaxPost({ url: `/api/v1/agent_runs/${runId}/retry`, data: {} }),
    onSuccess: options.onSuccess,
  });
}

/**
 * Which backends this deployment can run work on, and whether each is usable.
 *
 * Fetched rather than assumed, because "hosted execution is unavailable and
 * here is why" is the difference between a disabled button someone reports as
 * a bug and one they can act on.
 */
export function useExecutors() {
  return useQuery({
    queryKey: ['agent-run-executors'],
    queryFn: () => ajaxGet({ url: '/api/v1/agent_runs/meta/executors' }),
    staleTime: 5 * 60 * 1000,
  });
}

export interface RunPlan {
  repoUrl: string | null;
  repoPath: string | null;
  baseBranch: string | null;
  delivery: string | null;
  limits: { maxIterations: number; maxCostUsd: number };
}

/**
 * What a run against this issue would open, before one is opened.
 *
 * Resolved on the server because it layers workspace defaults, the issue's
 * modules and the request — and the client can see none of those. Without it
 * the sheet either says nothing about where the work will happen or guesses.
 */
export function useRunPlan(issueId?: string) {
  return useQuery<RunPlan>({
    queryKey: ['agent-run-plan', issueId],
    queryFn: () =>
      ajaxGet({ url: `/api/v1/agent_runs/meta/plan?issueId=${issueId}` }),
    enabled: Boolean(issueId),
    staleTime: 60 * 1000,
  });
}

export interface ModelChoiceOption {
  provider: string;
  id: string;
  label: string;
}

export interface ModelCatalogue {
  /** Providers this workspace holds a key for, catalogue or not. */
  providers: string[];
  models: ModelChoiceOption[];
}

/**
 * What this workspace's keys can actually drive.
 *
 * Fetched rather than hardcoded: a list of model ids compiled into the bundle
 * is out of date the week after it ships, and offering a model the workspace
 * has no key for produces a run that fails an hour later for a reason nobody
 * connects to the choice they made here.
 *
 * Provider and model arrive together because the choice is one choice made in
 * two steps — OpenRouter alone answers with 367 models, and a flat list of
 * those is not a picker.
 */
export function useModelCatalogue() {
  return useQuery<ModelCatalogue>({
    queryKey: ['agent-run-models'],
    queryFn: () => ajaxGet({ url: '/api/v1/agent_runs/meta/models' }),
    staleTime: 5 * 60 * 1000,
  });
}

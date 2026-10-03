import type { AgentRunCleanup, KnowledgeArmComparison } from '@vantikhq/types';

import { useQuery } from '@tanstack/react-query';

import { ajaxGet, ajaxPost, mutationHook } from 'services/utils';

export interface DelegateParams {
  issueId: string;
  agentUserId?: string;
  executor?: string;
  guidance?: string;
  config?: { provider?: string; model?: string; thinking?: string };
  force?: boolean;
}

export function delegate(params: DelegateParams) {
  return ajaxPost({ url: '/api/v1/agent_runs', data: params });
}

// The server's refusals here are written to be read — "this issue already has
// a run in progress", "this deployment has 2 executors; name one" — and each
// names a different thing to do next, so they reach the screen as they are.
export const useDelegateMutation = mutationHook(delegate, {
  fallback: 'Could not delegate this issue.',
});

export function cancelRun({
  runId,
  reason,
}: {
  runId: string;
  reason?: string;
}) {
  return ajaxPost({
    url: `/api/v1/agent_runs/${runId}/cancel`,
    data: { reason },
  });
}

export const useCancelRunMutation = mutationHook(cancelRun);

// Resolves to the new run the retry opened, so the caller can go to it.
export function retryRun({
  runId,
}: {
  runId: string;
}): Promise<{ id: string }> {
  return ajaxPost({ url: `/api/v1/agent_runs/${runId}/retry`, data: {} });
}

export const useRetryRunMutation = mutationHook(retryRun);

// Closes the run's pull request and deletes its branch on the git host, and
// resolves to what was done: the server says, per half, what it found.
export function cleanUpRun({
  runId,
}: {
  runId: string;
}): Promise<AgentRunCleanup> {
  return ajaxPost({ url: `/api/v1/agent_runs/${runId}/clean_up`, data: {} });
}

export const useCleanUpRunMutation = mutationHook(cleanUpRun, {
  fallback: 'Could not clean up after this run.',
});

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
  /** The repository's name, as its source gives it. */
  repository: string | null;
  /** Where it is: a URL or a path on the server's machine. */
  location: string | null;
  baseBranch: string | null;
  /** `pull_request` or `branch`, from what the source can do. */
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

/**
 * The runs handed the workspace's knowledge beside the runs held out from it.
 *
 * Numbers that move slowly — a run takes minutes and a pull request days — so
 * there is no reason to ask again while the page stays open.
 */
export function useKnowledgeArms(enabled = true) {
  return useQuery<KnowledgeArmComparison>({
    queryKey: ['agent-run-knowledge-arms'],
    queryFn: () => ajaxGet({ url: '/api/v1/agent_runs/meta/knowledge-arms' }),
    staleTime: 5 * 60 * 1000,
    enabled,
  });
}

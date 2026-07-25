import { useMutation, useQuery } from '@tanstack/react-query';

import type {
  KnowledgeGapType,
  PageEntryFacets,
  PageEntryStatus,
  PageEntryPolicy,
  PageEntryType,
  PageType,
} from 'common/types';

import { ajaxDelete, ajaxGet, ajaxPost } from 'services/utils';

/**
 * The page and entry API, as react-query hooks.
 *
 * Reads that have to be live — the tree, the entries on a page — come from the
 * synced MobX store rather than from here; these are the writes, plus the two
 * reads that are not synced because they are derived rather than stored
 * (knowledge gaps, and the facet counts the review rail opens on).
 */

export interface CreatePageParams {
  title: string;
  descriptionMarkdown?: string;
  description?: string;
  parentId?: string;
  entryPolicy?: PageEntryPolicy;
}

export function createPage(params: CreatePageParams) {
  return ajaxPost({ url: '/api/v1/pages', data: params });
}

export interface UpdatePageParams {
  pageId: string;
  title?: string;
  descriptionMarkdown?: string;
  /** Tiptap JSON, which is what the editor already holds. */
  description?: string;
  parentId?: string | null;
  sortOrder?: number;
  entryPolicy?: PageEntryPolicy;
}

export function updatePage({ pageId, ...data }: UpdatePageParams) {
  return ajaxPost({ url: `/api/v1/pages/${pageId}`, data });
}

export function deletePage({ pageId }: { pageId: string }) {
  return ajaxDelete({ url: `/api/v1/pages/${pageId}` });
}

export interface ConsolidatePageParams {
  pageId: string;
  descriptionMarkdown: string;
  entryIds?: string[];
}

export function consolidatePage({ pageId, ...data }: ConsolidatePageParams) {
  return ajaxPost({ url: `/api/v1/pages/${pageId}/consolidate`, data });
}

export interface UpdateEntryParams {
  pageEntryId: string;
  content?: string;
  scope?: string;
  status?: PageEntryStatus;
  verified?: boolean;
}

export function updatePageEntry({ pageEntryId, ...data }: UpdateEntryParams) {
  return ajaxPost({ url: `/api/v1/page_entries/${pageEntryId}`, data });
}

export interface BulkTriageParams {
  entryIds: string[];
  status: PageEntryStatus;
}

/**
 * One decision applied to a whole facet.
 *
 * This is what makes the rail usable at fifty entries: a reviewer accepts
 * everything one agent asserted about one path in a single action, instead of
 * clicking thirty-eight times and giving up at nine.
 */
export function bulkTriageEntries(data: BulkTriageParams) {
  return ajaxPost({ url: '/api/v1/page_entries/bulk', data });
}

export function createPageEntry({
  pageId,
  ...data
}: {
  pageId: string;
  content: string;
  scope?: string;
  standing?: boolean;
}) {
  return ajaxPost({ url: `/api/v1/page_entries?pageId=${pageId}`, data });
}

interface MutationParams<T> {
  onMutate?: () => void;
  onSuccess?: (data: T) => void;
  onError?: (error: string) => void;
}

function buildMutation<TVariables, TData>(
  mutationFn: (variables: TVariables) => Promise<unknown>,
  { onMutate, onSuccess, onError }: MutationParams<TData>,
) {
  return useMutation({
    mutationFn,
    onMutate: () => onMutate?.(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onError: (errorResponse: any) =>
      onError?.(errorResponse?.errors?.message || 'Error occured'),
    onSuccess: (data: unknown) => onSuccess?.(data as TData),
  });
}

export function useCreatePageMutation(params: MutationParams<PageType> = {}) {
  return buildMutation<CreatePageParams, PageType>(createPage, params);
}

export function useUpdatePageMutation(params: MutationParams<PageType> = {}) {
  return buildMutation<UpdatePageParams, PageType>(updatePage, params);
}

export function useDeletePageMutation(params: MutationParams<PageType> = {}) {
  return buildMutation<{ pageId: string }, PageType>(deletePage, params);
}

export function useConsolidatePageMutation(
  params: MutationParams<PageType> = {},
) {
  return buildMutation<ConsolidatePageParams, PageType>(
    consolidatePage,
    params,
  );
}

export function useUpdatePageEntryMutation(
  params: MutationParams<PageEntryType> = {},
) {
  return buildMutation<UpdateEntryParams, PageEntryType>(
    updatePageEntry,
    params,
  );
}

export function useBulkTriageMutation(
  params: MutationParams<{ updated: number; skipped: number }> = {},
) {
  return buildMutation<BulkTriageParams, { updated: number; skipped: number }>(
    bulkTriageEntries,
    params,
  );
}

export function useCreatePageEntryMutation(
  params: MutationParams<PageEntryType> = {},
) {
  return buildMutation<
    { pageId: string; content: string; scope?: string; standing?: boolean },
    PageEntryType
  >(createPageEntry, params);
}

/** Issues that link to a page. Documentation and work, not two worlds. */
export function usePageBacklinks(pageId?: string) {
  return useQuery<
    Array<{ id: string; title: string; number: number; teamId: string }>
  >({
    queryKey: ['page-backlinks', pageId],
    enabled: Boolean(pageId),
    queryFn: () =>
      ajaxGet({ url: `/api/v1/pages/${pageId}/backlinks` }) as Promise<
        Array<{ id: string; title: string; number: number; teamId: string }>
      >,
  });
}

/**
 * Free-text search over page bodies and standing facts.
 *
 * Deliberately the same endpoint agents call, so what a person finds in the
 * search box is exactly what an agent would be served — if the two diverged,
 * nobody could debug why an agent "did not know" something the wiki plainly
 * says.
 */
export function useKnowledgeSearch(query: string) {
  return useQuery<{ hits: KnowledgeHit[] }>({
    queryKey: ['knowledge-search', query],
    enabled: query.trim().length > 0,
    queryFn: () =>
      ajaxGet({
        url: `/api/v1/knowledge/search?query=${encodeURIComponent(query)}`,
      }) as Promise<{ hits: KnowledgeHit[] }>,
  });
}

export interface KnowledgeHit {
  kind: 'page' | 'entry';
  pageId: string;
  pageTitle: string;
  entryId: string | null;
  content: string;
  scope: string | null;
  verified: boolean;
}

/** Facet counts for a page's entries, or for the whole workspace. */
export function useEntryFacets(pageId?: string) {
  return useQuery<PageEntryFacets>({
    queryKey: ['page-entry-facets', pageId ?? 'workspace'],
    queryFn: () =>
      ajaxGet({
        url: `/api/v1/page_entries/facets${pageId ? `?pageId=${pageId}` : ''}`,
      }) as Promise<PageEntryFacets>,
  });
}

/**
 * Questions agents asked that the bank could not answer.
 *
 * The most direct answer available to "what should I document next": it says
 * what people actually needed, rather than what somebody thought to write down.
 */
export function useKnowledgeGaps() {
  return useQuery<KnowledgeGapType[]>({
    queryKey: ['knowledge-gaps'],
    queryFn: () =>
      ajaxGet({ url: '/api/v1/knowledge/gaps' }) as Promise<KnowledgeGapType[]>,
  });
}

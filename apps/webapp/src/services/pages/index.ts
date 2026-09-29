import type {
  KnowledgeAgreementReport,
  KnowledgeGardener,
  KnowledgeInboxChoiceEnum,
  KnowledgeInboxDetail,
  KnowledgeInboxList,
  KnowledgeInboxView,
  KnowledgeMap,
  LooseFactGroup,
  KnowledgeOverview,
  KnowledgeProof,
  KnowledgeReviewQueue,
  KnowledgeRunTrace,
  KnowledgeTracedRun,
  PageProposal,
} from '@vantikhq/types';

import { keepPreviousData, useQuery } from '@tanstack/react-query';

import type {
  PageEntryStatus,
  PageEntryPolicy,
  PageEntryType,
  PageKind,
  PageType,
} from 'common/types';

import { ajaxDelete, ajaxGet, ajaxPost, mutationHook } from 'services/utils';

import { moduleKnowledgeUrl } from './module-knowledge';
import {
  type PageProposalRef,
  proposalAnswerUrl,
  proposeAndAccept,
} from './page-proposals';
import {
  type CitedEntry,
  citedEntriesUrl,
  readSectionRefs,
  type SectionSources,
  sectionSources,
} from './page-sources';

export { MODULE_KNOWLEDGE_LIMIT } from './module-knowledge';
export { pageProposalSummary } from './page-proposals';
export type { SectionSources } from './page-sources';

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

export function createPage(params: CreatePageParams): Promise<PageType> {
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
  /** AUTHORED takes a generated page over by hand. */
  kind?: PageKind;
}

export function updatePage({
  pageId,
  ...data
}: UpdatePageParams): Promise<PageType> {
  return ajaxPost({ url: `/api/v1/pages/${pageId}`, data });
}

export function deletePage({ pageId }: { pageId: string }): Promise<PageType> {
  return ajaxDelete({ url: `/api/v1/pages/${pageId}` });
}

export interface ConsolidatePageParams {
  pageId: string;
  descriptionMarkdown: string;
  entryIds?: string[];
}

/** Proposes folding standing entries into a page body; nothing changes yet. */
export function consolidatePage({
  pageId,
  ...data
}: ConsolidatePageParams): Promise<PageProposal> {
  return ajaxPost({ url: `/api/v1/pages/${pageId}/consolidate`, data });
}

export function acceptPageProposal(ref: PageProposalRef): Promise<PageType> {
  return ajaxPost({ url: proposalAnswerUrl(ref, 'accept') });
}

export function declinePageProposal(
  ref: PageProposalRef,
): Promise<PageProposal> {
  return ajaxPost({ url: proposalAnswerUrl(ref, 'decline') });
}

export function answerPageProposal({
  accept,
  ...ref
}: PageProposalRef & { accept: boolean }): Promise<unknown> {
  return accept ? acceptPageProposal(ref) : declinePageProposal(ref);
}

/**
 * A person folding facts into the page they are reading: proposed, and
 * accepted by them at once, since accepting is what a person does.
 */
export function consolidateAndAccept(
  params: ConsolidatePageParams,
): Promise<PageType> {
  return proposeAndAccept(() => consolidatePage(params), acceptPageProposal);
}

export interface UpdateEntryParams {
  pageEntryId: string;
  content?: string;
  scope?: string;
  status?: PageEntryStatus;
  verified?: boolean;
}

export function updatePageEntry({
  pageEntryId,
  ...data
}: UpdateEntryParams): Promise<PageEntryType> {
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
export function bulkTriageEntries(
  data: BulkTriageParams,
): Promise<{ updated: number; skipped: number }> {
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
}): Promise<PageEntryType> {
  return ajaxPost({ url: `/api/v1/page_entries?pageId=${pageId}`, data });
}

export interface MoveEntriesParams {
  entryIds: string[];
  pageId: string;
  /** True when the person takes the gardener's suggestion. */
  suggested?: boolean;
}

/**
 * Files facts under a page. The server records each move on the trail of
 * the fact, and skips facts already on the page.
 */
export function moveEntries(
  data: MoveEntriesParams,
): Promise<{ moved: string[]; skipped: number }> {
  return ajaxPost({ url: '/api/v1/page_entries/move', data });
}

export const useCreatePageMutation = mutationHook(createPage);

export const useUpdatePageMutation = mutationHook(updatePage);

export const useDeletePageMutation = mutationHook(deletePage);

// Accepting marks the facts folded in and records the change in the page's
// history, and can answer an audit, so each is asked for again.
export const useConsolidatePageMutation = mutationHook(consolidateAndAccept, {
  invalidates: [
    'knowledge-review',
    'knowledge-agreement',
    'page-history',
    'knowledge-overview',
  ],
});

export const useAnswerPageProposalMutation = mutationHook(answerPageProposal, {
  invalidates: [
    'knowledge-review',
    'knowledge-agreement',
    'page-history',
    'knowledge-overview',
  ],
});

// Either can resolve an escalation or an audit, so the queue's reasons and
// the agreement figures are asked for again.
export const useUpdatePageEntryMutation = mutationHook(updatePageEntry, {
  invalidates: [
    'knowledge-review',
    'knowledge-agreement',
    'knowledge-overview',
  ],
});

export const useBulkTriageMutation = mutationHook(bulkTriageEntries, {
  invalidates: [
    'knowledge-review',
    'knowledge-agreement',
    'knowledge-overview',
  ],
});

export const useCreatePageEntryMutation = mutationHook(createPageEntry, {
  invalidates: ['knowledge-overview'],
});

/**
 * Makes the page that the gardener suggests for a group of facts outside
 * any page, and files the facts under it.
 */
export async function makePageFor({
  title,
  entryIds,
}: {
  title: string;
  entryIds: string[];
}): Promise<PageType> {
  const page = await createPage({ title });

  await moveEntries({ entryIds, pageId: page.id, suggested: true });

  return page;
}

export const useMakePageForMutation = mutationHook(makePageFor, {
  invalidates: ['knowledge-overview', 'loose-facts'],
});

export const useMoveEntriesMutation = mutationHook(moveEntries, {
  invalidates: [
    'knowledge-overview',
    'loose-facts',
    'page-entry-proofs',
    'knowledge-review',
  ],
});

/**
 * The groups of facts outside any page that the gardener suggests to file
 * under this page.
 */
export function useLooseFactsFor(pageId?: string) {
  return useQuery<LooseFactGroup[]>({
    queryKey: ['loose-facts', pageId],
    enabled: Boolean(pageId),
    queryFn: () =>
      ajaxGet({
        url: `/api/v1/knowledge/loose?${new URLSearchParams({ pageId: pageId ?? '' })}`,
      }) as Promise<LooseFactGroup[]>,
  });
}

export interface RevertParams {
  pageId: string;
  historyId: string;
}

export function revertPageBody({
  pageId,
  historyId,
}: RevertParams): Promise<PageType> {
  return ajaxPost({ url: `/api/v1/pages/${pageId}/revert/${historyId}` });
}

export const useRevertPageMutation = mutationHook(revertPageBody);

export interface PageRevision {
  id: string;
  pageId: string;
  userId: string | null;
  createdAt: string;
  changes: Record<string, unknown>;
  /** What the body said before this change; null if it did not touch the body. */
  previousBodyMarkdown: string | null;
}

/**
 * What has happened to a page.
 *
 * Not synced, because history is read when someone asks "what changed?" and
 * never needed to render the page itself — keeping fifty revisions per page in
 * the local cache would cost every reader for the benefit of the occasional
 * auditor.
 */
export function usePageHistory(pageId?: string, enabled = true) {
  return useQuery<PageRevision[]>({
    queryKey: ['page-history', pageId],
    enabled: Boolean(pageId) && enabled,
    queryFn: () =>
      ajaxGet({ url: `/api/v1/pages/${pageId}/history` }) as Promise<
        PageRevision[]
      >,
  });
}

/**
 * What each section of a generated page was written from: the entries it
 * cites, in use or not. Keyed on the page's last change, so a refresh that
 * rewrote a section is read again.
 */
export function usePageSources(pageId?: string, revision?: string) {
  return useQuery<SectionSources[]>({
    queryKey: ['page-sources', pageId, revision],
    enabled: Boolean(pageId),
    queryFn: async () => {
      const page = (await ajaxGet({ url: `/api/v1/pages/${pageId}` })) as {
        sections?: unknown;
      };
      const sections = readSectionRefs(page.sections);
      const url = citedEntriesUrl(
        sections.flatMap((section) => section.entryIds),
      );
      const entries = url ? ((await ajaxGet({ url })) as CitedEntry[]) : [];

      return sectionSources(sections, entries);
    },
  });
}

/**
 * The page body as markdown.
 *
 * The store holds tiptap JSON, which is what the editor wants, but folding
 * notes into the body means handing the API prose — so the one place that needs
 * markdown asks for it rather than shipping a converter to every browser.
 */
export function usePageMarkdown(pageId?: string, enabled = true) {
  return useQuery<{ descriptionMarkdown: string }>({
    queryKey: ['page-markdown', pageId],
    enabled: Boolean(pageId) && enabled,
    queryFn: () =>
      ajaxGet({ url: `/api/v1/pages/${pageId}` }) as Promise<{
        descriptionMarkdown: string;
      }>,
  });
}

export type PageLinkType =
  'TEAM' | 'PROJECT' | 'ISSUE' | 'PAGE' | 'PRODUCT' | 'MODULE' | 'CAPABILITY';

export interface PageLink {
  id: string;
  pageId: string;
  entityType: PageLinkType;
  entityId: string;
  label: string;
  teamId?: string;
  /**
   * How the target is addressed in a URL when that is not its id — an issue key
   * ("ENG-42"), a team identifier ("ENG"), a product or module key ("cloud").
   * Those routes are keyed that way, so pushing the raw uuid lands on a page
   * that resolves nothing.
   */
  key?: string;
}

/**
 * What a page is linked to.
 *
 * Not synced: links change rarely and are read when a page is open, so keeping
 * a fifth model in the local cache would cost every reader for the benefit of
 * one section.
 */
export function usePageLinks(pageId?: string) {
  return useQuery<PageLink[]>({
    queryKey: ['page-links', pageId],
    enabled: Boolean(pageId),
    queryFn: () =>
      ajaxGet({ url: `/api/v1/pages/${pageId}/links` }) as Promise<PageLink[]>,
  });
}

export interface RelatedPage {
  /** The page. */
  id: string;
  title: string;
  /** The edge, so this list can unlink without reading the page's links back. */
  linkId: string;
}

/**
 * The other direction: the pages linked to one issue, project or team.
 *
 * The same edges `usePageLinks` reads, entered from the work rather than from
 * the documentation. Read on demand for the same reason — an issue is opened far
 * more often than its pages change.
 */
export function useRelatedPages(entityType: PageLinkType, entityId?: string) {
  return useQuery<RelatedPage[]>({
    queryKey: ['related-pages', entityType, entityId],
    enabled: Boolean(entityId),
    queryFn: () =>
      ajaxGet({
        url: `/api/v1/pages/related?entityType=${entityType}&entityId=${entityId}`,
      }) as Promise<RelatedPage[]>,
  });
}

/**
 * The standing knowledge about a set of modules: the entries whose scope
 * resolves to any of them.
 *
 * Read from the server rather than the synced store, because the store loads
 * entries one page at a time, and a module's knowledge is spread across pages.
 */
export function useModuleKnowledge(moduleIds: string[]) {
  const url = moduleKnowledgeUrl(moduleIds);

  return useQuery<PageEntryType[]>({
    queryKey: ['module-knowledge', url],
    enabled: moduleIds.length > 0,
    queryFn: () => ajaxGet({ url }) as Promise<PageEntryType[]>,
  });
}

export function createPageLink({
  pageId,
  ...data
}: {
  pageId: string;
  entityType: PageLinkType;
  entityId: string;
}): Promise<PageLink> {
  return ajaxPost({ url: `/api/v1/pages/${pageId}/links`, data });
}

export function deletePageLink({
  pageId,
  linkId,
}: {
  pageId: string;
  linkId: string;
}): Promise<{ id: string }> {
  return ajaxDelete({ url: `/api/v1/pages/${pageId}/links/${linkId}` });
}

export const useCreatePageLinkMutation = mutationHook(createPageLink);

export const useDeletePageLinkMutation = mutationHook(deletePageLink);

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
  /** The page of the hit, or null for a fact outside any page. */
  pageId: string | null;
  pageTitle: string;
  entryId: string | null;
  content: string;
  scope: string | null;
  verified: boolean;
  /** For an entry a page cites, that page: the entry is its evidence. */
  evidenceFor?: { pageId: string; pageTitle: string } | null;
}

/**
 * The Pages home in one read: the trust of the facts in use, each page with
 * its product, and the gaps agents could not close.
 */
export function useKnowledgeOverview() {
  return useQuery<KnowledgeOverview>({
    queryKey: ['knowledge-overview'],
    queryFn: () =>
      ajaxGet({
        url: '/api/v1/knowledge/overview',
      }) as Promise<KnowledgeOverview>,
  });
}

export interface AnswerGapParams {
  gapId: string;
  entryId: string;
}

/** Closes a gap with the fact a person wrote to answer it. */
export function answerKnowledgeGap({ gapId, entryId }: AnswerGapParams) {
  return ajaxPost({
    url: `/api/v1/knowledge/gaps/${gapId}/answer`,
    data: { entryId },
  });
}

export const useAnswerGapMutation = mutationHook(answerKnowledgeGap, {
  invalidates: ['knowledge-overview'],
});

/** An entry as the entry list serves it: with its trust and its citations. */
export type ProvenEntry = PageEntryType & KnowledgeProof;

/**
 * Every entry on a page with its proof. The synced store holds the entries
 * but not their citation checks, so the page view reads them here. The
 * caller passes a signature of the synced entries, and a change to them
 * reads the list again.
 */
export function usePageEntryProofs(pageId?: string, signature?: string) {
  return useQuery<ProvenEntry[]>({
    queryKey: ['page-entry-proofs', pageId, signature],
    enabled: Boolean(pageId),
    placeholderData: keepPreviousData,
    queryFn: () =>
      ajaxGet({
        url: `/api/v1/page_entries?${new URLSearchParams({ pageId: pageId ?? '' })}`,
      }) as Promise<ProvenEntry[]>,
  });
}

/**
 * Why each waiting entry is waiting, and the decisions drawn for audit.
 *
 * Not synced: triage decisions are read when someone sits down to review,
 * and the entries themselves still come live from the store. Scoped to a
 * page when one is given.
 */
export function useKnowledgeReview(pageId?: string, enabled = true) {
  return useQuery<KnowledgeReviewQueue>({
    queryKey: ['knowledge-review', pageId ?? 'workspace'],
    enabled,
    queryFn: () =>
      ajaxGet({
        url: pageId
          ? `/api/v1/knowledge/review?pageId=${pageId}`
          : '/api/v1/knowledge/review',
      }) as Promise<KnowledgeReviewQueue>,
  });
}

export interface ResolveAuditParams {
  decisionId: string;
  /** Whether triage was right to do what it did. */
  agree: boolean;
}

export function resolveAudit({ decisionId, agree }: ResolveAuditParams) {
  return ajaxPost({
    url: `/api/v1/knowledge/review/${decisionId}/audit`,
    data: { agree },
  });
}

export const useResolveAuditMutation = mutationHook(resolveAudit, {
  invalidates: [
    'knowledge-review',
    'knowledge-agreement',
    'knowledge-overview',
  ],
});

export interface ResolveProposalParams {
  proposalId: string;
  /** Whether to archive the entry, as the gardener asks. */
  accept: boolean;
}

export function resolveProposal({ proposalId, accept }: ResolveProposalParams) {
  return ajaxPost({
    url: `/api/v1/knowledge/review/proposals/${proposalId}`,
    data: { accept },
  });
}

// Accepting archives the entry, which can be one an audit was about.
export const useResolveProposalMutation = mutationHook(resolveProposal, {
  invalidates: [
    'knowledge-review',
    'knowledge-agreement',
    'knowledge-overview',
  ],
});

/**
 * How far triage and people agree, per decision type, and which types have
 * stopped acting because of it. Moves only as verdicts arrive.
 */
export function useKnowledgeAgreement(enabled = true) {
  return useQuery<KnowledgeAgreementReport>({
    queryKey: ['knowledge-agreement'],
    enabled,
    staleTime: 60 * 1000,
    queryFn: () =>
      ajaxGet({
        url: '/api/v1/knowledge/agreement',
      }) as Promise<KnowledgeAgreementReport>,
  });
}

/**
 * Needs you: every knowledge decision that waits on a person, shared by the
 * workspace. Scoped to a page when one is given.
 */
export function useKnowledgeInbox(
  view: KnowledgeInboxView = 'open',
  pageId?: string,
) {
  return useQuery<KnowledgeInboxList>({
    queryKey: ['knowledge-inbox', view, pageId ?? 'workspace'],
    placeholderData: keepPreviousData,
    // The sidebar and the Pages bar read it on every view; a decision
    // invalidates it at once.
    staleTime: 30 * 1000,
    queryFn: () =>
      ajaxGet({
        url: `/api/v1/knowledge/inbox?${new URLSearchParams({
          view,
          ...(pageId ? { pageId } : {}),
        })}`,
      }) as Promise<KnowledgeInboxList>,
  });
}

/** One item of Needs you, with its thread and what deciding it needs. */
export function useKnowledgeInboxItem(id?: string) {
  return useQuery<KnowledgeInboxDetail>({
    queryKey: ['knowledge-inbox-item', id],
    enabled: Boolean(id),
    queryFn: () =>
      ajaxGet({
        url: `/api/v1/knowledge/inbox/${id}`,
      }) as Promise<KnowledgeInboxDetail>,
  });
}

export interface AssignInboxItemParams {
  id: string;
  /** Null takes everyone off it. */
  assigneeId: string | null;
}

export function assignInboxItem({ id, assigneeId }: AssignInboxItemParams) {
  return ajaxPost({
    url: `/api/v1/knowledge/inbox/${id}/assign`,
    data: { assigneeId },
  });
}

export const useAssignInboxItemMutation = mutationHook(assignInboxItem, {
  invalidates: ['knowledge-inbox', 'knowledge-inbox-item'],
});

export interface CommentInboxItemParams {
  id: string;
  body: string;
}

export function commentInboxItem({ id, body }: CommentInboxItemParams) {
  return ajaxPost({
    url: `/api/v1/knowledge/inbox/${id}/comments`,
    data: { body },
  });
}

export const useCommentInboxItemMutation = mutationHook(commentInboxItem, {
  invalidates: ['knowledge-inbox-item'],
});

export interface DecideInboxItemParams {
  id: string;
  choice: KnowledgeInboxChoiceEnum;
  /** For a gap: the fact that answers it. */
  entryId?: string;
}

export function decideInboxItem({
  id,
  choice,
  entryId,
}: DecideInboxItemParams) {
  return ajaxPost({
    url: `/api/v1/knowledge/inbox/${id}/decide`,
    data: { choice, ...(entryId ? { entryId } : {}) },
  });
}

// A decision changes facts, so everything that shows them reads again.
export const useDecideInboxItemMutation = mutationHook(decideInboxItem, {
  invalidates: [
    'knowledge-inbox',
    'knowledge-inbox-item',
    'knowledge-review',
    'knowledge-overview',
    'knowledge-agreement',
    'page-entry-proofs',
    'loose-facts',
  ],
});

/** What the gardener did: its figures, the life of a fact, its log and jobs. */
export function useKnowledgeGardener() {
  return useQuery<KnowledgeGardener>({
    queryKey: ['knowledge-gardener'],
    staleTime: 60 * 1000,
    queryFn: () =>
      ajaxGet({
        url: '/api/v1/knowledge/gardener',
      }) as Promise<KnowledgeGardener>,
  });
}

/** The graph of what the workspace knows, at the end of `asOf` or today. */
export function useKnowledgeMap(asOf?: string) {
  return useQuery<KnowledgeMap>({
    queryKey: ['knowledge-map', asOf ?? 'today'],
    placeholderData: keepPreviousData,
    staleTime: 60 * 1000,
    queryFn: () =>
      ajaxGet({
        url: `/api/v1/knowledge/map${asOf ? `?asOf=${asOf}` : ''}`,
      }) as Promise<KnowledgeMap>,
  });
}

/** The runs whose packs can be traced, newest first. */
export function useKnowledgeTracedRuns() {
  return useQuery<KnowledgeTracedRun[]>({
    queryKey: ['knowledge-traces'],
    queryFn: () =>
      ajaxGet({ url: '/api/v1/knowledge/traces' }) as Promise<
        KnowledgeTracedRun[]
      >,
  });
}

/** Why one run got the facts it got, for one of its packs. */
export function useKnowledgeRunTrace(runId?: string, traceId?: string) {
  return useQuery<KnowledgeRunTrace>({
    queryKey: ['knowledge-trace', runId, traceId ?? 'start'],
    enabled: Boolean(runId),
    placeholderData: keepPreviousData,
    queryFn: () =>
      ajaxGet({
        url: `/api/v1/knowledge/traces/${runId}${traceId ? `?traceId=${traceId}` : ''}`,
      }) as Promise<KnowledgeRunTrace>,
  });
}

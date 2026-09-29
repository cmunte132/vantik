import type { Editor as EditorT } from '@tiptap/core';

import { RiArrowDownSLine, RiMoreLine } from '@remixicon/react';
import { Button } from '@vantikhq/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@vantikhq/ui/components/dropdown-menu';
import { Editor, EditorExtensions } from '@vantikhq/ui/components/editor/index';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import { useRouter } from 'next/router';
import * as React from 'react';
import { useDebouncedCallback } from 'use-debounce';

import { useEditorSuggestionItems } from 'modules/issues/components/use-editor-suggestion-items';

import { getTiptapJSON } from 'common';
import { AiWritingExtension } from 'common/editor';
import { vantikIssueExtension } from 'common/editor/vantik-issue-extension';
import { AppLayout } from 'common/layouts/app-layout';
import { MainLayout } from 'common/layouts/main-layout';
import { PageEntryPolicy, PageKind, type PageType } from 'common/types';

import { useEditorPasteHandler } from 'hooks/use-editor-paste-handler';
import { useAllUsers } from 'hooks/users';

import {
  useDeletePageMutation,
  useKnowledgeOverview,
  useKnowledgeReview,
  usePageBacklinks,
  usePageLinks,
  useUpdatePageMutation,
} from 'services/pages';
import { byUse } from 'services/pages/overview';

import { useContextStore } from 'store/global-context-provider';

import { EditorRibbon } from './editor-ribbon';
import { type Crumb, Header } from './header';
import { FactsRail, PageReviewDialog, usePageFacts } from './memory-rail';
import { usePageNavigation } from './navigation';
import { PageHistory } from './page-history';
import { PageSources } from './page-sources';
import { PageTitle } from './page-title';
import { NO_PRODUCT } from './product-pages';
import { RelatedLinks } from './related-links';
import { SaveIndicator, type SaveState } from './save-indicator';
import { ago, CARD, Chip } from './trust';

/**
 * What each policy means, said where a person actually chooses one.
 *
 * These used to sit as a permanent line of prose under the breadcrumb, which
 * explained the setting to everyone who was not changing it, every time they
 * opened the page. In the menu it is there exactly when it is the question.
 */
const POLICY_HELP: Record<string, string> = {
  [PageEntryPolicy.OPEN]: 'Agents append freely',
  [PageEntryPolicy.CURATED]: 'Budget enforced, duplicates challenged',
  [PageEntryPolicy.LOCKED]: 'Agents can read but not append',
};

const SinglePageView = observer(() => {
  const router = useRouter();
  const { pageId, workspaceSlug } = router.query;
  const { pagesStore, pageEntriesStore } = useContextStore();

  const page: PageType | undefined = pagesStore.getPageWithId(pageId as string);
  const { handlePaste } = useEditorPasteHandler();
  const { suggestionItems } = useEditorSuggestionItems();
  const [editorInstance, setEditorInstance] = React.useState<EditorT>();
  const [saveState, setSaveState] = React.useState<SaveState>('idle');
  const [showHistory, setShowHistory] = React.useState(false);

  const { mutate: updatePage } = useUpdatePageMutation({
    onSuccess: () => setSaveState('saved'),
    onError: () => setSaveState('error'),
  });
  const { mutate: deletePage } = useDeletePageMutation({
    onSuccess: () =>
      router.push({
        pathname: '/[workspaceSlug]/pages',
        query: { workspaceSlug },
      }),
  });

  // Entries are loaded per page, the same way checklist items are per issue —
  // the whole workspace's entries are not something any one view needs.
  React.useEffect(() => {
    if (pageId) {
      pageEntriesStore.load(pageId as string);
    }
  }, [pageId, pageEntriesStore]);

  // What this editor last sent. Anything arriving over sync that does not match
  // it came from somewhere else — an agent rewriting the page, a consolidate,
  // a revert, or the same page open in another tab.
  const lastSentRef = React.useRef<string | undefined>(undefined);
  const [externalRevision, setExternalRevision] = React.useState(0);

  React.useEffect(() => {
    if (!page || page.description === undefined) {
      return;
    }

    if (lastSentRef.current === undefined) {
      lastSentRef.current = page.description;
      return;
    }

    if (page.description === lastSentRef.current) {
      return;
    }

    // Remount the editor on the new body. Tiptap takes its value once, so
    // without this the document silently diverges from what is stored — you
    // would fold notes into the page, be told it worked, and watch nothing
    // change, then overwrite the fold with the stale text on your next
    // keystroke.
    lastSentRef.current = page.description;
    setExternalRevision((revision: number) => revision + 1);
  }, [page?.description]);

  // The page id travels with the text rather than being read off `page` when
  // the timer fires. use-debounce calls the newest version of this function
  // with the arguments it was given a second ago, so a page switch inside the
  // debounce window would otherwise send the page you were writing in to the
  // page you just opened, overwriting it.
  const onBodyChange = useDebouncedCallback(
    (pageId: string, content: string) => {
      const { json: description } = getTiptapJSON(content);

      lastSentRef.current = JSON.stringify(description);

      updatePage({
        pageId,
        // Tiptap JSON straight through: the editor already holds this format,
        // and converting to markdown and back to satisfy the API would drop
        // whatever markdown cannot express.
        description: JSON.stringify(description),
      });
    },
    1000,
    // Leaving the page inside that second sends what is waiting rather than
    // dropping it.
    { flushOnExit: true },
  );

  const onTitleChange = useDebouncedCallback(
    (pageId: string, title: string) => {
      updatePage({ pageId, title });
    },
    1000,
    { flushOnExit: true },
  );

  // Marked pending the instant a key is pressed, not when the debounced
  // request goes out — the window where the browser holds the only copy is
  // exactly the window worth admitting to.
  const markDirty = () => setSaveState('pending');

  const ancestors: PageType[] = page ? pagesStore.getAncestors(page.id) : [];
  // The gardener writes a generated page from the facts its sections cite,
  // and the server refuses a hand edit to its body until it is taken over.
  const generated = page?.kind === PageKind.GENERATED;

  const actions = page ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Page settings">
          <RiMoreLine size={16} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[260px]">
        <DropdownMenuLabel>Who may add facts</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={page.entryPolicy}
          onValueChange={(entryPolicy: string) =>
            updatePage({
              pageId: page.id,
              entryPolicy: entryPolicy as PageEntryPolicy,
            })
          }
        >
          {Object.values(PageEntryPolicy).map((policy) => (
            <DropdownMenuRadioItem key={policy} value={policy}>
              <div className="flex flex-col">
                <span>{policy.toLowerCase()}</span>
                <span className="text-muted-foreground">
                  {POLICY_HELP[policy]}
                </span>
              </div>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />

        {/* Nesting existed everywhere except here: the model, the breadcrumb
            and the tree all understood a parent, and nothing in the app could
            set one. */}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Move to</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-[300px] overflow-y-auto">
            <DropdownMenuItem
              onClick={() => updatePage({ pageId: page.id, parentId: null })}
            >
              Top level
            </DropdownMenuItem>
            {pagesStore.getPages
              .filter(
                (candidate: PageType) =>
                  candidate.id !== page.id &&
                  candidate.id !== page.parentId &&
                  // A page cannot be moved inside its own subtree; the server
                  // refuses it, and offering it here would only produce an
                  // error message where a missing option says it better.
                  !pagesStore
                    .getAncestors(candidate.id)
                    .some((ancestor: PageType) => ancestor.id === page.id),
              )
              .map((candidate: PageType) => (
                <DropdownMenuItem
                  key={candidate.id}
                  onClick={() =>
                    updatePage({ pageId: page.id, parentId: candidate.id })
                  }
                >
                  {candidate.title || 'Untitled page'}
                </DropdownMenuItem>
              ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {/* Agents may rewrite a body to keep it current, so the way to see
            what one did — and undo it — has to be on the page itself. */}
        <DropdownMenuItem onClick={() => setShowHistory(true)}>
          Page history
        </DropdownMenuItem>

        {generated && (
          <DropdownMenuItem
            onClick={() =>
              updatePage({ pageId: page.id, kind: PageKind.AUTHORED })
            }
          >
            Take over by hand
          </DropdownMenuItem>
        )}

        <DropdownMenuItem onClick={() => deletePage({ pageId: page.id })}>
          Delete page
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  return (
    <MainLayout
      scrollable
      header={
        <PageHeader
          page={page}
          ancestors={ancestors}
          actions={
            <div className="flex items-center gap-3">
              <SaveIndicator state={saveState} />
              {actions}
            </div>
          }
        />
      }
    >
      {!page ? (
        <div className="p-6 text-muted-foreground">
          This page does not exist, or has been deleted.
        </div>
      ) : (
        <div className="p-3 md:p-5 flex flex-wrap gap-5 items-start">
          <article
            className={cn(
              CARD,
              'min-w-0 grow-[999] basis-[440px] px-5 py-6 md:px-11 md:py-9 flex flex-col gap-3.5',
            )}
          >
            {/* Keyed on the page so switching pages resets the local value,
                rather than leaving the previous page's title sitting above
                the new page's body. */}
            <PageTitle
              key={page.id}
              value={page.title}
              onChange={(title) => {
                markDirty();
                onTitleChange(page.id, title);
              }}
            />

            <PageChips page={page} />

            {generated ? (
              <div className="flex flex-col gap-1">
                <p>
                  <span className="text-muted-foreground">Answers </span>
                  {page.question}
                </p>
                <p className="text-muted-foreground">
                  Generated: written from the facts its sections cite, and
                  edited as they change. Take it over from the menu to edit it
                  by hand.
                </p>
              </div>
            ) : (
              /* Above the content and sticky, so it is still reachable
                 partway down a long page. */
              <EditorRibbon editor={editorInstance} />
            )}

            <Editor
              key={`${page.id}-${externalRevision}-${page.kind}`}
              editable={!generated}
              value={page.description}
              onCreate={setEditorInstance}
              onChange={(content: string) => {
                markDirty();
                onBodyChange(page.id, content);
              }}
              handlePaste={handlePaste}
              extensions={[vantikIssueExtension, AiWritingExtension]}
              // There is no formatting toolbar anywhere in this product —
              // the editor is slash-command and selection-driven, like the
              // issue description. That is only discoverable if something
              // says so, and an empty page said nothing at all.
              placeholder="Write, or press '/' for headings, lists and more…"
              className="min-h-[300px] text-[15px] leading-relaxed"
            >
              <EditorExtensions suggestionItems={suggestionItems} />
            </Editor>

            <RewriteBanner pageId={page.id} />

            {generated && (
              <PageSources pageId={page.id} revision={page.updatedAt} />
            )}

            <RelatedLinks pageId={page.id} />

            <Backlinks pageId={page.id} />

            <PageHistory
              pageId={page.id}
              open={showHistory}
              onOpenChange={setShowHistory}
            />
          </article>

          {/* Beside the page, not under it. What the page tells agents is
              standing metadata, which this product keeps in a rail. */}
          <FactsRail
            pageId={page.id}
            className="min-w-0 grow basis-[340px] max-w-full"
          />
        </div>
      )}
    </MainLayout>
  );
});

/**
 * The trail to the page: its product, its parents, and the page itself as a
 * switcher between the pages beside it. Who edited it last is on the right.
 */
const PageHeader = observer(
  ({
    page,
    ancestors,
    actions,
  }: {
    page?: PageType;
    ancestors: PageType[];
    actions: React.ReactNode;
  }) => {
    const { data: overview } = useKnowledgeOverview();
    const { pagesStore } = useContextStore();
    const { users } = useAllUsers();
    const goToPage = usePageNavigation();

    if (!page) {
      return <Header needsYou={false} actions={actions} />;
    }

    const own = overview?.pages.find((candidate) => candidate.id === page.id);
    const productId = own?.productId ?? null;
    const product = overview?.products.find(
      (candidate) => candidate.id === productId,
    );
    const siblings = (overview?.pages ?? [])
      .filter(
        (candidate) =>
          candidate.productId === productId && candidate.id !== page.id,
      )
      .sort(byUse);
    const editor = users.find(
      (user) => user.id === (page.updatedById ?? page.createdById),
    );

    const crumbs: Crumb[] = [
      ...(own
        ? [
            {
              label: product?.name ?? 'Other pages',
              pathname: '/[workspaceSlug]/pages/product/[productId]',
              query: { productId: productId ?? NO_PRODUCT },
            },
          ]
        : []),
      ...ancestors.map((ancestor) => ({
        label: ancestor.title || 'Untitled page',
        pathname: '/[workspaceSlug]/pages/[pageId]',
        query: { pageId: ancestor.id },
      })),
      {
        label: (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-grayAlpha-100 hover:bg-grayAlpha-200 font-medium max-w-[240px]"
              >
                <span className="truncate">
                  {page.title || 'Untitled page'}
                </span>
                <RiArrowDownSLine size={14} className="shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-[280px] max-h-[360px] overflow-y-auto"
            >
              <DropdownMenuLabel>
                {siblings.length
                  ? `Other pages in ${product?.name ?? 'Other pages'}`
                  : 'No other pages here'}
              </DropdownMenuLabel>
              {siblings.map((sibling) => (
                <DropdownMenuItem
                  key={sibling.id}
                  onClick={() => goToPage(sibling.id)}
                >
                  <span className="truncate">
                    {pagesStore.getPageWithId(sibling.id)?.title ||
                      sibling.title ||
                      'Untitled page'}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ];

    return (
      <Header
        needsYou={false}
        crumbs={crumbs}
        note={
          siblings.length
            ? `${siblings.length} other ${siblings.length === 1 ? 'page' : 'pages'} in ${product?.name ?? 'Other pages'}`
            : undefined
        }
        actions={
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground whitespace-nowrap hidden lg:inline">
              Edited{editor ? ` by ${editor.fullname ?? editor.username}` : ''}{' '}
              · {ago(page.updatedAt)}
            </span>
            {actions}
          </div>
        }
      />
    );
  },
);

/**
 * What the page is about, and when the code under its facts was last read:
 * the product, the teams it is linked to, and the newest check of its code.
 */
const PageChips = observer(({ page }: { page: PageType }) => {
  const { data: overview } = useKnowledgeOverview();
  const { data: links } = usePageLinks(page.id);
  const { facts } = usePageFacts(page.id);
  const productId = overview?.pages.find(
    (candidate) => candidate.id === page.id,
  )?.productId;
  const product = overview?.products.find(
    (candidate) => candidate.id === productId,
  );
  const teams = (links ?? []).filter((link) => link.entityType === 'TEAM');
  const checked = facts
    .filter((fact) => fact.lastCheckedSha && fact.lastCheckedAt)
    .sort((a, b) =>
      (b.lastCheckedAt ?? '').localeCompare(a.lastCheckedAt ?? ''),
    )[0];

  if (!product && teams.length === 0 && !checked) {
    return null;
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {product && <Chip>{product.name}</Chip>}
      {teams.map((team) => (
        <Chip key={team.id}>{team.label}</Chip>
      ))}
      {checked && (
        <Chip tone="code">
          Checked against {checked.lastCheckedSha?.slice(0, 8)} ·{' '}
          {ago(checked.lastCheckedAt)}
        </Chip>
      )}
    </div>
  );
});

/**
 * A rewrite of the body that the gardener proposed and a person has not
 * read. The body does not change until a person accepts it.
 */
const RewriteBanner = observer(({ pageId }: { pageId: string }) => {
  const { data: review } = useKnowledgeReview(pageId);
  const [reviewing, setReviewing] = React.useState(false);
  const proposal = review?.pageProposals.find(
    (candidate) => candidate.pageId === pageId,
  );

  if (!proposal) {
    return null;
  }

  const count = proposal.entryIds.length;

  return (
    <div className="flex items-center gap-3 flex-wrap px-3.5 py-3 rounded-lg bg-[oklch(60%_0.13_240/0.08)]">
      <span className="grow basis-[260px] leading-snug text-foreground/85">
        <span className="font-semibold">
          The gardener can fold {count} new {count === 1 ? 'fact' : 'facts'}{' '}
          into this page.
        </span>{' '}
        The page does not change until you accept.
      </span>
      <button
        type="button"
        className="bg-background-3 rounded-md px-3 py-1.5 font-medium shadow-[0_0_0_1px_oklch(0%_0_0/0.1)]"
        onClick={() => setReviewing(true)}
      >
        Read the rewrite
      </button>
      <PageReviewDialog
        pageId={pageId}
        open={reviewing}
        onOpenChange={setReviewing}
      />
    </div>
  );
});

/**
 * The issues that link here.
 *
 * A runbook nobody links to from an issue is one nobody reads when it matters,
 * so the page says who is relying on it.
 */
const Backlinks = observer(({ pageId }: { pageId: string }) => {
  const { data: issues } = usePageBacklinks(pageId);
  const { teamsStore } = useContextStore();
  const router = useRouter();
  const { workspaceSlug } = router.query;

  if (!issues || issues.length === 0) {
    return null;
  }

  return (
    <section className="border-t border-border mt-8 pt-4 mb-8 flex flex-col gap-1">
      <h2 className="text-muted-foreground mb-1">Referenced by</h2>
      {issues.map((issue) => {
        const team = teamsStore.getTeamWithId(issue.teamId);
        const key = team ? `${team.identifier}-${issue.number}` : issue.number;

        return (
          <button
            key={issue.id}
            type="button"
            className="text-left hover:underline"
            onClick={() =>
              router.push({
                pathname: '/[workspaceSlug]/issue/[issueId]',
                query: { workspaceSlug, issueId: key },
              })
            }
          >
            <span className="text-muted-foreground mr-2">{key}</span>
            {issue.title}
          </button>
        );
      })}
    </section>
  );
});

export function SinglePage() {
  return <SinglePageView />;
}

SinglePage.getLayout = function getLayout(page: React.ReactElement) {
  return <AppLayout>{page}</AppLayout>;
};

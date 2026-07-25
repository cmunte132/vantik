import type { Editor as EditorT } from '@tiptap/core';

import { Button } from '@vantikhq/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@vantikhq/ui/components/dropdown-menu';
import { Editor, EditorExtensions } from '@vantikhq/ui/components/editor/index';
import { ScrollArea } from '@vantikhq/ui/components/scroll-area';
import { MoreLine } from '@vantikhq/ui/icons';
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
import { PageEntryPolicy, type PageType } from 'common/types';

import { useEditorPasteHandler } from 'hooks/use-editor-paste-handler';

import {
  useDeletePageMutation,
  usePageBacklinks,
  useUpdatePageMutation,
} from 'services/pages';

import { useContextStore } from 'store/global-context-provider';

import { EditorRibbon } from './editor-ribbon';
import { Header } from './header';
import { PageHistory } from './page-history';
import { PageMemory } from './page-memory';
import { PageNav } from './page-nav';
import { PageTitle } from './page-title';
import { SaveIndicator, type SaveState } from './save-indicator';

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
    onSuccess: () => router.push(`/${workspaceSlug}/pages`),
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

  const onBodyChange = useDebouncedCallback((content: string) => {
    const { json: description } = getTiptapJSON(content);

    lastSentRef.current = JSON.stringify(description);

    updatePage({
      pageId: page.id,
      // Tiptap JSON straight through: the editor already holds this format, and
      // converting to markdown and back to satisfy the API would drop whatever
      // markdown cannot express.
      description: JSON.stringify(description),
    });
  }, 1000);

  const onTitleChange = useDebouncedCallback((title: string) => {
    updatePage({ pageId: page.id, title });
  }, 1000);

  // Marked pending the instant a key is pressed, not when the debounced
  // request goes out — the window where the browser holds the only copy is
  // exactly the window worth admitting to.
  const markDirty = () => setSaveState('pending');

  const ancestors: PageType[] = page ? pagesStore.getAncestors(page.id) : [];

  const actions = page ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Page settings">
          <MoreLine size={16} />
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

        {/* Agents may rewrite a body to keep it current, so the way to see
            what one did — and undo it — has to be on the page itself. */}
        <DropdownMenuItem onClick={() => setShowHistory(true)}>
          Page history
        </DropdownMenuItem>

        <DropdownMenuItem onClick={() => deletePage({ pageId: page.id })}>
          Delete page
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  return (
    <MainLayout
      header={
        <Header
          ancestors={ancestors}
          page={page}
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
        <div className="flex h-[calc(100%_-_38px)] w-full">
          <PageNav activePageId={page.id} />

          <ScrollArea className="grow h-full">
            <div className="flex justify-center w-full">
              <div className="grow flex flex-col max-w-[80ch] pt-8 pb-8 px-6">
                {/* Keyed on the page so switching pages in the tree resets
                    the local value, rather than leaving the previous page's
                    title sitting above the new page's body. */}
                <PageTitle
                  key={page.id}
                  value={page.title}
                  onChange={(title) => {
                    markDirty();
                    onTitleChange(title);
                  }}
                />

                {/* Above the content and sticky, so it is still reachable
                    partway down a long page. */}
                <EditorRibbon editor={editorInstance} />

                <Editor
                  key={`${page.id}-${externalRevision}`}
                  value={page.description}
                  onCreate={setEditorInstance}
                  onChange={(content: string) => {
                    markDirty();
                    onBodyChange(content);
                  }}
                  handlePaste={handlePaste}
                  extensions={[vantikIssueExtension, AiWritingExtension]}
                  // There is no formatting toolbar anywhere in this product —
                  // the editor is slash-command and selection-driven, like the
                  // issue description. That is only discoverable if something
                  // says so, and an empty page said nothing at all.
                  placeholder="Write, or press '/' for headings, lists and more…"
                  className="min-h-[300px] mt-3 text-md"
                >
                  <EditorExtensions suggestionItems={suggestionItems} />
                </Editor>

                {/* Below the body rather than in a rail beside it. What
                    agents are told about this page is metadata about the
                    document, in the way "referenced by" is — not a second
                    task competing with writing for the width of the screen. */}
                <PageMemory pageId={page.id} />

                <Backlinks pageId={page.id} />

                <PageHistory
                  pageId={page.id}
                  open={showHistory}
                  onOpenChange={setShowHistory}
                />
              </div>
            </div>
          </ScrollArea>
        </div>
      )}
    </MainLayout>
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
            onClick={() => router.push(`/${workspaceSlug}/issue/${key}`)}
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

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

import { EntryRail } from './entry-rail';
import { Header } from './header';
import { PageTitle } from './page-title';

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
  const { mutate: updatePage } = useUpdatePageMutation();
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

  const onBodyChange = useDebouncedCallback((content: string) => {
    const { json: description } = getTiptapJSON(content);

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

        <DropdownMenuItem onClick={() => deletePage({ pageId: page.id })}>
          Delete page
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  return (
    <MainLayout
      header={<Header ancestors={ancestors} page={page} actions={actions} />}
    >
      {!page ? (
        <div className="p-6 text-muted-foreground">
          This page does not exist, or has been deleted.
        </div>
      ) : (
        <div className="flex h-[calc(100%_-_38px)] w-full">
          <ScrollArea className="grow h-full">
            <div className="flex justify-center w-full">
              <div className="grow flex flex-col max-w-[80ch] py-8 px-6">
                {/* Keyed on the page so switching pages in the tree resets
                    the local value, rather than leaving the previous page's
                    title sitting above the new page's body. */}
                <PageTitle
                  key={page.id}
                  value={page.title}
                  onChange={(title) => onTitleChange(title)}
                />

                <Editor
                  value={page.description}
                  onChange={onBodyChange}
                  handlePaste={handlePaste}
                  extensions={[vantikIssueExtension, AiWritingExtension]}
                  // There is no formatting toolbar anywhere in this product —
                  // the editor is slash-command and selection-driven, like the
                  // issue description. That is only discoverable if something
                  // says so, and an empty page said nothing at all.
                  placeholder="Write, or press '/' for headings, lists and more…"
                  className="min-h-[300px] mt-4 text-md"
                >
                  <EditorExtensions suggestionItems={suggestionItems} />
                </Editor>

                <Backlinks pageId={page.id} />
              </div>
            </div>
          </ScrollArea>

          <EntryRail pageId={page.id} />
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

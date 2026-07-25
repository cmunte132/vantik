import { Button } from '@vantikhq/ui/components/button';
import { Editor, EditorExtensions } from '@vantikhq/ui/components/editor/index';
import { ScrollArea } from '@vantikhq/ui/components/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vantikhq/ui/components/select';
import { observer } from 'mobx-react-lite';
import { useRouter } from 'next/router';
import * as React from 'react';
import { useDebouncedCallback } from 'use-debounce';

import { useEditorSuggestionItems } from 'modules/issues/components/use-editor-suggestion-items';

import { getTiptapJSON } from 'common';
import { AiWritingExtension } from 'common/editor';
import { vantikIssueExtension } from 'common/editor/vantik-issue-extension';
import { PageEntryPolicy, type PageType } from 'common/types';

import { AppLayout } from 'common/layouts/app-layout';

import { useEditorPasteHandler } from 'hooks/use-editor-paste-handler';

import {
  useDeletePageMutation,
  usePageBacklinks,
  useUpdatePageMutation,
} from 'services/pages';

import { useContextStore } from 'store/global-context-provider';

import { EntryRail } from './entry-rail';

/** What each policy means, said in the place a person actually chooses one. */
const POLICY_HELP: Record<PageEntryPolicy, string> = {
  [PageEntryPolicy.OPEN]: 'Agents append freely. For scratch pages.',
  [PageEntryPolicy.CURATED]:
    'Agents append under a budget, and duplicates are challenged.',
  [PageEntryPolicy.LOCKED]:
    'Agents can read this page but not append to it.',
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

  if (!page) {
    return (
      <div className="p-6 text-muted-foreground">
        This page does not exist, or has been deleted.
      </div>
    );
  }

  const ancestors: PageType[] = pagesStore.getAncestors(page.id);

  return (
    <div className="flex h-full w-full">
      <ScrollArea className="grow h-full">
        <div className="flex justify-center w-full">
          <div className="grow flex flex-col gap-2 max-w-[97ch] py-4 px-6">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1 text-muted-foreground flex-wrap">
                {ancestors.map((ancestor) => (
                  <React.Fragment key={ancestor.id}>
                    <button
                      type="button"
                      className="hover:underline"
                      onClick={() =>
                        router.push(`/${workspaceSlug}/pages/${ancestor.id}`)
                      }
                    >
                      {ancestor.title}
                    </button>
                    <span>/</span>
                  </React.Fragment>
                ))}
                <span>{page.title}</span>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <Select
                  value={page.entryPolicy}
                  onValueChange={(entryPolicy: PageEntryPolicy) =>
                    updatePage({ pageId: page.id, entryPolicy })
                  }
                >
                  <SelectTrigger className="w-[140px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(PageEntryPolicy).map((policy) => (
                      <SelectItem key={policy} value={policy}>
                        {policy}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Button
                  variant="ghost"
                  onClick={() => deletePage({ pageId: page.id })}
                >
                  Delete
                </Button>
              </div>
            </div>

            <p className="text-muted-foreground">
              {POLICY_HELP[page.entryPolicy as PageEntryPolicy]}
            </p>

            <input
              defaultValue={page.title}
              onChange={(event) => onTitleChange(event.target.value)}
              className="bg-transparent border-0 outline-none text-xl font-medium mt-2"
              placeholder="Page title"
            />

            <Editor
              value={page.description}
              onChange={onBodyChange}
              handlePaste={handlePaste}
              extensions={[vantikIssueExtension, AiWritingExtension]}
              className="min-h-[50px] mb-8 mt-3 text-md"
            >
              <EditorExtensions suggestionItems={suggestionItems} />
            </Editor>

            <Backlinks pageId={page.id} />
          </div>
        </div>
      </ScrollArea>

      <EntryRail pageId={page.id} />
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
    <section className="border-t pt-4 mb-8 flex flex-col gap-1">
      <h2 className="text-muted-foreground">Referenced by</h2>
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

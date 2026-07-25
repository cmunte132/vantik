import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@vantikhq/ui/components/command';
import { Loader } from '@vantikhq/ui/components/loader';
import { useRouter } from 'next/router';
import React from 'react';
import { useDebouncedCallback } from 'use-debounce';

import { ModalIssueItem } from 'modules/issues/components/modals/modal-issue-item';

import type { IssueType } from 'common/types';

import { useCurrentWorkspace } from 'hooks/workspace';

import { useKnowledgeSearch, type KnowledgeHit } from 'services/pages';
import { useGetSearchIssuesQuery } from 'services/search';

interface SearchDialogProps {
  open: boolean;
  setOpen: (value: boolean) => void;
}

interface SearchIssueType extends IssueType {
  issueNumber: string;
}

export function SearchDialog({ open, setOpen }: SearchDialogProps) {
  const workspace = useCurrentWorkspace();
  const [query, setQuery] = React.useState('');
  const { push } = useRouter();

  const {
    data: issues,
    isLoading,
    refetch,
  } = useGetSearchIssuesQuery({
    workspaceId: workspace.id,
    query,
  });

  // The knowledge bank is searched from the same box, because "has anyone
  // written this down" and "has anyone filed this" are the same question asked
  // twice, and a person should not have to guess which surface holds the answer.
  const { data: knowledge } = useKnowledgeSearch(query);

  React.useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const fetchData = useDebouncedCallback(() => {
    refetch();
  }, 500);

  const onSelect = (value: string) => {
    push(`/${workspace.slug}/issue/${value.toUpperCase()}`);
    setOpen(false);
    setQuery('');
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      commandProps={{ shouldFilter: false }}
    >
      <CommandInput
        placeholder="Type a command or search..."
        onValueChange={(value: string) => setQuery(value)}
      />
      {!isLoading &&
        (issues?.length ?? 0) === 0 &&
        (knowledge?.hits?.length ?? 0) === 0 && (
        <CommandEmpty>
          <span className="text-muted-foreground">No results found.</span>
        </CommandEmpty>
        )}
      {isLoading && <Loader />}
      {!isLoading && (
        <CommandList className="py-2">
          {(knowledge?.hits ?? []).map((hit: KnowledgeHit) => (
            <CommandItem
              key={`${hit.pageId}:${hit.entryId ?? 'body'}`}
              // cmdk keys selection off the value, so several facts from one
              // page sharing it collapse into a single reachable row.
              value={`page:${hit.pageId}:${hit.entryId ?? 'body'}`}
              className="m-2 !py-2"
              onSelect={() => {
                push(`/${workspace.slug}/pages/${hit.pageId}`);
                setOpen(false);
                setQuery('');
              }}
            >
              <div className="flex flex-col gap-0.5 w-full">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">
                    {hit.kind === 'page' ? 'Page' : 'Fact'}
                  </span>
                  <span className="truncate">{hit.pageTitle}</span>
                </div>
                <span className="text-muted-foreground truncate">
                  {hit.content}
                </span>
              </div>
            </CommandItem>
          ))}
          {(issues ?? []).filter(Boolean).map((issue: SearchIssueType) => (
            <CommandItem
              key={issue.id}
              value={issue.issueNumber}
              className="m-2 !py-2"
              onSelect={onSelect}
            >
              <ModalIssueItem issue={issue} />
            </CommandItem>
          ))}
        </CommandList>
      )}
    </CommandDialog>
  );
}

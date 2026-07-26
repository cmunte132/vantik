'use client';

import { CreateIssueLine, SearchLine } from '@vantikhq/ui/icons';
import { observer } from 'mobx-react-lite';
import React from 'react';

import { useNewIssue } from 'modules/issues/new-issue';
import { SearchDialog } from 'modules/search';

import { TooltipWrapper } from 'common/wrappers/tooltip-wrapper';

/**
 * Search was a 16px unlabelled icon sharing a cramped row with the workspace
 * avatar. Giving it a full-width target with its shortcut printed on it makes
 * it findable without a tooltip; compose keeps an icon button beside it because
 * it is a single action, not a field.
 */
export const SidebarActions = observer(() => {
  const [search, setSearch] = React.useState(false);
  const { openNewIssue } = useNewIssue();

  return (
    <>
      <div data-sidebar="actions" className="mb-1.5 mt-2 flex gap-1.5">
        <TooltipWrapper tooltip="Search issues (⌘ + /)">
          <button
            type="button"
            data-sidebar="rail-item"
            onClick={() => {
              setSearch(true);
            }}
            className="flex h-[30px] min-w-0 flex-1 items-center justify-center gap-2 rounded
              bg-grayAlpha-100 px-2.5 text-sm text-sidebar-muted outline-none
              transition-colors hover:bg-grayAlpha-200 focus-visible:ring-1
              focus-visible:ring-ring"
          >
            <SearchLine size={14} className="shrink-0" />
            <span className="truncate" data-rail-hide>
              Search
            </span>
            <kbd
              data-rail-hide
              className="ml-auto shrink-0 rounded-sm bg-grayAlpha-200 px-1.5 py-0.5 font-mono text-xs"
            >
              ⌘/
            </kbd>
          </button>
        </TooltipWrapper>

        <TooltipWrapper tooltip="Create new issue (C)">
          <button
            type="button"
            data-sidebar="rail-item"
            onClick={() => {
              openNewIssue({});
            }}
            className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded
              bg-grayAlpha-100 text-sidebar-foreground outline-none transition-colors
              hover:bg-grayAlpha-200 focus-visible:ring-1 focus-visible:ring-ring"
          >
            <CreateIssueLine size={16} />
          </button>
        </TooltipWrapper>
      </div>

      <SearchDialog open={search} setOpen={setSearch} />
    </>
  );
});

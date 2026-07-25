import { Button } from '@vantikhq/ui/components/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@vantikhq/ui/components/tooltip';
import { AddLine, ChevronRight } from '@vantikhq/ui/icons';
import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import { useRouter } from 'next/router';
import * as React from 'react';

import type { PageType } from 'common/types';

import { useContextStore } from 'store/global-context-provider';

interface PageTreeProps {
  /** Highlighted page, when one is open. */
  activePageId?: string;
  onSelect: (pageId: string) => void;
  /** Creates a child of the given page. Omit to hide the affordance. */
  onCreateChild?: (parentId: string) => void;
}

/**
 * The documentation tree.
 *
 * Where a page sits is half of what its title means — "Deployment" under
 * "Runbooks" and "Deployment" under "Sales" are different documents — so the
 * navigation is a tree rather than the flat list a `getPages` response is.
 */
export const PageTree = observer(
  ({ activePageId, onSelect, onCreateChild }: PageTreeProps) => {
    const { pagesStore } = useContextStore();

    return (
      <div className="flex flex-col gap-px">
        <Branch
          parentId={null}
          depth={0}
          activePageId={activePageId}
          onSelect={onSelect}
          onCreateChild={onCreateChild}
          pagesStore={pagesStore}
        />
      </div>
    );
  },
);

interface NodeProps extends PageTreeProps {
  depth: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pagesStore: any;
}

interface BranchProps extends NodeProps {
  parentId: string | null;
}

const Branch = observer(
  ({
    parentId,
    depth,
    activePageId,
    onSelect,
    onCreateChild,
    pagesStore,
  }: BranchProps) => {
    const children: PageType[] = pagesStore.getChildren(parentId);

    if (children.length === 0) {
      return null;
    }

    return (
      <>
        {children.map((page) => (
          <TreeNode
            key={page.id}
            page={page}
            depth={depth}
            activePageId={activePageId}
            onSelect={onSelect}
            onCreateChild={onCreateChild}
            pagesStore={pagesStore}
          />
        ))}
      </>
    );
  },
);

const TreeNode = observer(
  ({
    page,
    depth,
    activePageId,
    onSelect,
    onCreateChild,
    pagesStore,
  }: NodeProps & { page: PageType }) => {
    const hasChildren = pagesStore.getChildren(page.id).length > 0;

    const holdsActivePage =
      hasChildren &&
      Boolean(activePageId) &&
      (page.id === activePageId ||
        pagesStore
          .getAncestors(activePageId)
          .some((ancestor: PageType) => ancestor.id === page.id));

    const [expanded, setExpanded] = React.useState(holdsActivePage);

    // Ancestors of the open page expand, so following a link into a nested page
    // does not leave the reader in a tree that hides where they are. As an
    // effect rather than an initial value because the tree stays mounted beside
    // the page while they move around it — computing this once at mount meant
    // it only ever worked for the page that happened to be open on first paint.
    React.useEffect(() => {
      if (holdsActivePage) {
        setExpanded(true);
      }
    }, [holdsActivePage]);

    return (
      <>
        <div
          className={cn(
            'group flex items-center gap-1 rounded px-1 py-1 hover:bg-grayAlpha-100',
            page.id === activePageId && 'bg-grayAlpha-100',
          )}
          style={{ paddingLeft: `${depth * 12 + 4}px` }}
        >
          <button
            type="button"
            aria-label={expanded ? 'Collapse' : 'Expand'}
            className={cn(
              'shrink-0 w-4 h-4 flex items-center justify-center',
              !hasChildren && 'invisible',
            )}
            onClick={() => setExpanded((open: boolean) => !open)}
          >
            <ChevronRight
              size={12}
              className={cn('transition-transform', expanded && 'rotate-90')}
            />
          </button>

          <Button
            variant="ghost"
            className="h-auto p-0 justify-start grow text-left font-normal min-w-0"
            onClick={() => onSelect(page.id)}
          >
            <span className="truncate">{page.title || 'Untitled page'}</span>
          </Button>

          {/* The only way to nest from the app. The hierarchy has always been
              in the model — parent, ancestors, breadcrumbs, this indentation —
              but every create path passed no parent, so every page made here
              was a root and the tree could only ever be flat. */}
          {onCreateChild && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`New page under ${page.title || 'Untitled page'}`}
                  className="shrink-0 h-5 px-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => onCreateChild(page.id)}
                >
                  <AddLine size={12} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Add a page inside</TooltipContent>
            </Tooltip>
          )}
        </div>

        {expanded && (
          <Branch
            parentId={page.id}
            depth={depth + 1}
            activePageId={activePageId}
            onSelect={onSelect}
            onCreateChild={onCreateChild}
            pagesStore={pagesStore}
          />
        )}
      </>
    );
  },
);

/** Navigates to a page. Kept here so both the tree and search use one route. */
export function usePageNavigation() {
  const router = useRouter();
  const { workspaceSlug } = router.query;

  return React.useCallback(
    (pageId: string) => {
      router.push({
        pathname: '/[workspaceSlug]/pages/[pageId]',
        query: { workspaceSlug, pageId },
      });
    },
    [router, workspaceSlug],
  );
}

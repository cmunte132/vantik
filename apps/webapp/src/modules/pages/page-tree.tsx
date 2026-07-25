import { Button } from '@vantikhq/ui/components/button';
import { cn } from '@vantikhq/ui/lib/utils';
import { ChevronRight } from '@vantikhq/ui/icons';
import { observer } from 'mobx-react-lite';
import { useRouter } from 'next/router';
import * as React from 'react';

import type { PageType } from 'common/types';

import { useContextStore } from 'store/global-context-provider';

interface PageTreeProps {
  /** Highlighted page, when one is open. */
  activePageId?: string;
  onSelect: (pageId: string) => void;
}

/**
 * The documentation tree.
 *
 * Where a page sits is half of what its title means — "Deployment" under
 * "Runbooks" and "Deployment" under "Sales" are different documents — so the
 * navigation is a tree rather than the flat list a `getPages` response is.
 */
export const PageTree = observer(({ activePageId, onSelect }: PageTreeProps) => {
  const { pagesStore } = useContextStore();

  return (
    <div className="flex flex-col gap-px">
      <Branch
        parentId={null}
        depth={0}
        activePageId={activePageId}
        onSelect={onSelect}
        pagesStore={pagesStore}
      />
    </div>
  );
});

interface NodeProps extends PageTreeProps {
  depth: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pagesStore: any;
}

interface BranchProps extends NodeProps {
  parentId: string | null;
}

const Branch = observer(
  ({ parentId, depth, activePageId, onSelect, pagesStore }: BranchProps) => {
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
    pagesStore,
  }: NodeProps & { page: PageType }) => {
    const hasChildren = pagesStore.getChildren(page.id).length > 0;
    // Ancestors of the open page start expanded, so deep-linking to a nested
    // page does not land the reader in a tree that hides where they are.
    const [expanded, setExpanded] = React.useState(
      hasChildren &&
        (page.id === activePageId ||
          (activePageId
            ? pagesStore
                .getAncestors(activePageId)
                .some((ancestor: PageType) => ancestor.id === page.id)
            : false)),
    );

    return (
      <>
        <div
          className={cn(
            'flex items-center gap-1 rounded px-1 py-1 hover:bg-grayAlpha-100',
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
            className="h-auto p-0 justify-start grow text-left font-normal"
            onClick={() => onSelect(page.id)}
          >
            <span className="truncate">{page.title}</span>
          </Button>
        </div>

        {expanded && (
          <Branch
            parentId={page.id}
            depth={depth + 1}
            activePageId={activePageId}
            onSelect={onSelect}
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
      router.push(`/${workspaceSlug}/pages/${pageId}`);
    },
    [router, workspaceSlug],
  );
}

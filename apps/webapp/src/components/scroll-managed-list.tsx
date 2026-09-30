import React from 'react';
import { List, type ListProps, type ScrollParams } from 'react-virtualized';

import { usePathname } from 'common/router';

interface ScrollManagedListProps extends ListProps {
  listId: string;
}

/** The height of every row, added up: at most how far the list can scroll. */
function contentHeight({ rowCount, rowHeight }: ListProps) {
  if (typeof rowHeight === 'number') {
    return rowCount * rowHeight;
  }

  let total = 0;

  for (let index = 0; index < rowCount; index++) {
    total += rowHeight({ index });
  }

  return total;
}

function RestoredList({
  storageKey,
  ...listProps
}: ListProps & { storageKey: string }) {
  const [scrollTop, setScrollTop] = React.useState(() => {
    const saved = parseInt(sessionStorage.getItem(storageKey), 10);

    return Number.isNaN(saved) ? 0 : saved;
  });

  // The rows and the height settle after the first render, so the cut is made
  // on every render. The grid takes the offset it is given whenever that
  // differs from its own, which is what brings it back.
  const maxScrollTop = Math.max(0, contentHeight(listProps) - listProps.height);

  const handleScroll = React.useCallback(
    (params: ScrollParams) => {
      setScrollTop(params.scrollTop);
      sessionStorage.setItem(storageKey, params.scrollTop.toString());
      if (listProps.onScroll) {
        listProps.onScroll(params);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storageKey, listProps.onScroll],
  );

  return (
    <List
      height={listProps.height}
      rowHeight={listProps.rowHeight}
      rowCount={listProps.rowCount}
      width={listProps.width}
      rowRenderer={listProps.rowRenderer}
      scrollTop={Math.min(scrollTop, maxScrollTop)}
      onScroll={handleScroll}
      {...listProps}
    />
  );
}

/**
 * A virtualized list that keeps its scroll position while the page is open.
 *
 * The position belongs to one list on one page. It was kept by the list id
 * alone, and every list grouped by status shares one: a project of five
 * issues opened at the offset of a team list scrolled far down, and drew
 * nothing. The grid draws the rows at the offset it holds, not the one the
 * browser clamps to, so an offset past the end is also cut to the end.
 *
 * Next keeps the page mounted from one project to the next, so the key also
 * remounts the list, and each page starts from its own position.
 */
export function ScrollManagedList({
  listId,
  ...listProps
}: ScrollManagedListProps) {
  const pathname = usePathname();
  const storageKey = `list-${pathname}-${listId}-scroll`;

  return (
    <RestoredList
      key={storageKey}
      storageKey={storageKey}
      {...(listProps as ListProps)}
    />
  );
}

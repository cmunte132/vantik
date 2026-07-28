import { cn } from '@vantikhq/ui/lib/utils';
import { observer } from 'mobx-react-lite';
import React from 'react';

import { ContentBox } from './content-box';

interface MainLayoutProps {
  header: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /**
   * Scrolls the content when it is taller than the window.
   *
   * `ContentBox` clips what it holds, so that the rounded corners of the box
   * stay rounded and so that a virtualized list inside it scrolls itself. A
   * page of ordinary content has no such list, and without this its lower half
   * is simply unreachable.
   *
   * A page whose child does its own scrolling must leave this off, or the two
   * scrollbars fight.
   */
  scrollable?: boolean;
}

/**
 * The box becomes a column, so that the header keeps its height and the content
 * takes the rest of the box.
 */
export const SCROLLABLE_BOX = 'flex flex-col';

/**
 * The content of a scrollable page.
 *
 * `min-h-0` is the part that does the work, and the part that is easy to drop.
 * A flex child is at least as tall as its own content by default, so without it
 * this element grows past the bottom of the box and `overflow-y-auto` finds
 * nothing to scroll — which is the bug this whole prop exists to fix, and it
 * comes back silently.
 */
export const SCROLLABLE_CONTENT = 'flex-1 min-h-0 overflow-y-auto';

export const MainLayout = observer(
  ({ header, children, className, scrollable }: MainLayoutProps) => {
    return (
      <main className={cn('flex flex-col h-[100vh]', className)}>
        <ContentBox innerClassName={cn(scrollable && SCROLLABLE_BOX)}>
          {header}

          {scrollable ? (
            <div className={SCROLLABLE_CONTENT}>{children}</div>
          ) : (
            children
          )}
        </ContentBox>
      </main>
    );
  },
);

import { describe, expect, it } from 'vitest';

import { SCROLLABLE_BOX, SCROLLABLE_CONTENT } from './main-layout';

/**
 * A page of ordinary content has to scroll.
 *
 * `ContentBox` clips what it holds: the box has rounded corners to keep, and
 * every list page inside it carries a virtualized scroller of its own. A page
 * with no such scroller — the module page, the product page, the two lists on
 * the product axis — was therefore cut off at the bottom of the window, with no
 * way to reach the rest.
 *
 * These hold the three classes that make the fix work. Each one is easy to drop
 * in a tidy-up, and dropping any of them brings the bug back with nothing on
 * screen to say why.
 */

describe('the scrollable page layout', () => {
  /**
   * The header keeps its height and the content takes the rest. Without a
   * column the two are blocks, and `flex-1` on the content means nothing.
   */
  it('makes the box a column', () => {
    expect(SCROLLABLE_BOX).toContain('flex');
    expect(SCROLLABLE_BOX).toContain('flex-col');
  });

  it('gives the content the space the header does not use', () => {
    expect(SCROLLABLE_CONTENT).toContain('flex-1');
  });

  it('scrolls the content rather than the window', () => {
    expect(SCROLLABLE_CONTENT).toContain('overflow-y-auto');
  });

  /**
   * The one that actually broke, and the one a reader deletes as redundant. A
   * flex child is at least as tall as its content, so without `min-h-0` this
   * element grows past the bottom of the box and there is nothing to scroll:
   * `overflow-y-auto` is then set on an element that always fits.
   */
  it('lets the content be shorter than the content inside it', () => {
    expect(SCROLLABLE_CONTENT).toContain('min-h-0');
  });
});

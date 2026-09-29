import * as React from 'react';

/**
 * The width of an element, read again when it changes. A view uses it to
 * choose its layout by the room it has, and not by the window: the sidebar
 * takes a different share of the window at each width.
 */
export function useWidth<T extends HTMLElement>(): [
  React.RefCallback<T>,
  number,
] {
  const [width, setWidth] = React.useState(0);
  const observer = React.useRef<ResizeObserver | null>(null);

  const ref = React.useCallback((element: T | null) => {
    observer.current?.disconnect();

    if (!element) {
      return;
    }

    observer.current = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.current.observe(element);
    setWidth(element.getBoundingClientRect().width);
  }, []);

  React.useEffect(() => () => observer.current?.disconnect(), []);

  return [ref, width];
}

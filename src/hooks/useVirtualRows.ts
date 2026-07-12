import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Fixed-row-height list virtualization ("windowing").
 *
 * Directory listings can hit thousands of entries; mounting a DOM node per
 * entry makes every render and layout O(N). With fixed-height rows only the
 * visible slice (plus overscan) needs to exist, so render cost is constant
 * regardless of list length.
 *
 * Perf notes:
 *   - Scroll state is stored as a *row index*, not raw scrollTop, so React
 *     bails out of re-rendering until scrolling actually crosses into a new
 *     row (one state change per `rowHeight` pixels instead of one per event).
 *   - The viewport is tracked in rows too (windows are freely resizable);
 *     the ResizeObserver fires once on observe, providing the initial size.
 *
 * The caller owns the scroll container: attach `containerRef` and `onScroll`
 * to it, give the inner list `height: totalHeight` with `position: relative`,
 * and absolutely position each row at `index * rowHeight`. Remount the
 * component (e.g. `key={path}`) to reset scroll on navigation.
 */
export function useVirtualRows({
  count,
  rowHeight,
  overscan,
}: {
  /** Total number of rows in the list. */
  count: number;
  /** Fixed height of every row, in px. */
  rowHeight: number;
  /** Extra rows rendered above/below the viewport to hide scroll pop-in. */
  overscan: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [firstRow, setFirstRow] = useState(0);
  const [viewportRows, setViewportRows] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const rows = Math.ceil(el.clientHeight / rowHeight);
      setViewportRows((prev) => (prev === rows ? prev : rows));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [rowHeight]);

  const onScroll = useCallback(
    (e: React.UIEvent<HTMLElement>) => {
      const row = Math.floor(e.currentTarget.scrollTop / rowHeight);
      setFirstRow((prev) => (prev === row ? prev : row));
    },
    [rowHeight],
  );

  const start = Math.max(0, firstRow - overscan);
  // +1 covers the partially visible row at the bottom edge.
  const end = Math.min(count, firstRow + viewportRows + 1 + overscan);

  return { containerRef, onScroll, start, end, totalHeight: count * rowHeight };
}

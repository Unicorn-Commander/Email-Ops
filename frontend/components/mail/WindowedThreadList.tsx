'use client';

/**
 * WindowedThreadList — hand-rolled list virtualization for the conversation
 * list.
 *
 * Large folders accumulate thousands of loaded rows after "Load more", and the
 * unwindowed list mounts every one of them — each scroll or selection then
 * pays for the whole list. This component windows the list: only the rows near
 * the viewport (plus a generous overscan) are mounted, with plain spacer divs
 * standing in for everything else at their exact heights, so scrollbar
 * geometry and every scroll position stay identical to the unwindowed render.
 *
 * Everything here is in service of ZERO visual/behavioral change:
 *
 * - Rows are variable-height (the snippet line and chip row are conditional),
 *   so heights are estimated first and corrected from the live DOM after each
 *   commit. Measurements are keyed by thread id, so they survive refreshes,
 *   reorders and load-more. When a correction changes the height of content
 *   ABOVE the viewport, scrollTop is compensated in the same layout pass so
 *   nothing on screen shifts (native scroll anchoring is disabled with
 *   `overflow-anchor: none` so the manual compensation is the only authority).
 * - Date-bucket headers stay `position: sticky` SIBLINGS of the rows — a
 *   per-item wrapper would clip each header's sticky range to a single row.
 *   When the window starts mid-bucket, the governing header is synthesized
 *   just above the first mounted row (its height deducted from the spacer) so
 *   the pinned current-bucket header keeps working exactly as before.
 * - `pinnedIds` rows (the keyboard cursor and the open thread) are ALWAYS
 *   mounted at their true offsets, each with its ±1 neighbours: the page calls
 *   `rowRefs.get(id)?.scrollIntoView()` synchronously inside the j/k handler —
 *   before React re-renders — so the target row must already be in the DOM.
 *   The first and last rows stay mounted too (they are the j/k entry points
 *   when no cursor exists yet). Off-window pinned rows render as extra runs
 *   between exact-height spacers, so scrollIntoView lands precisely.
 *
 * Purely presentational: selection, cursor and checked state all live in the
 * page, so rows unmounting and remounting is invisible to that state.
 */

import {
  Fragment,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/** Rows mounted beyond each edge of the viewport. */
const DEFAULT_OVERSCAN = 10;
/** Row-height guess until the first real rows are measured. */
const ROW_ESTIMATE = 96;
/** Bucket-header-height guess until one is measured. */
const HEADER_ESTIMATE = 30;
/** Ignore sub-pixel measurement jitter below this. */
const EPSILON = 0.5;

export interface WindowedThreadListProps<T extends { id: string }> {
  /** The full loaded thread list, newest-first (windowing never reorders it). */
  items: readonly T[];
  /** Date-bucket label for an item; a header renders whenever it changes. */
  bucketKey: (item: T) => string;
  /** Renders one sticky bucket header (the caller owns its markup/classes). */
  renderHeader: (bucket: string) => ReactNode;
  /** Renders one conversation row (the caller owns props, refs and handlers). */
  renderRow: (item: T) => ReactNode;
  /**
   * Thread ids that must stay mounted even outside the window (cursor + open
   * thread). Nullish entries are ignored so callers can pass state directly.
   */
  pinnedIds?: readonly (string | null | undefined)[];
  overscan?: number;
}

/** What each direct DOM child of the wrapper is, in render order — lets the
 *  measure pass walk `wrapper.children` without per-row wrapper elements. */
type Slot = { kind: 'spacer' } | { kind: 'header' } | { kind: 'row'; id: string };

/** Header label (or null) per index — a header renders where the bucket changes. */
function computeHeaderAt<T extends { id: string }>(
  items: readonly T[],
  bucketKey: (item: T) => string,
): (string | null)[] {
  let prev: string | null = null;
  return items.map((it) => {
    const bucket = bucketKey(it);
    const show = bucket !== prev;
    prev = bucket;
    return show ? bucket : null;
  });
}

/**
 * Cumulative offsets: offsets[i] = top of item i (header included), so
 * offsets[items.length] is the total content height. Unmeasured rows use the
 * mean of measured heights (or ROW_ESTIMATE before anything is measured).
 */
function computeOffsets(
  ids: readonly string[],
  headerAt: readonly (string | null)[],
  heights: ReadonlyMap<string, number>,
  headerH: number,
): Float64Array {
  let sum = 0;
  let count = 0;
  for (const v of heights.values()) {
    sum += v;
    count += 1;
  }
  const estimate = count > 0 ? sum / count : ROW_ESTIMATE;
  const offsets = new Float64Array(ids.length + 1);
  let acc = 0;
  for (let i = 0; i < ids.length; i++) {
    acc += (headerAt[i] ? headerH : 0) + (heights.get(ids[i]) ?? estimate);
    offsets[i + 1] = acc;
  }
  return offsets;
}

/** First index whose bottom edge sits below `y` (i.e. the item at height y). */
function indexAt(offsets: Float64Array, y: number): number {
  const n = offsets.length - 1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] > y) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** The wrapper's top edge in the scroller's content coordinates. */
function wrapperTop(scroller: HTMLElement, wrap: HTMLElement): number {
  return (
    wrap.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
  );
}

export function WindowedThreadList<T extends { id: string }>({
  items,
  bucketKey,
  renderHeader,
  renderRow,
  pinnedIds,
  overscan = DEFAULT_OVERSCAN,
}: WindowedThreadListProps<T>) {
  const n = items.length;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  /** Measured row heights by thread id (survives unmounts and list refreshes). */
  const heightsRef = useRef(new Map<string, number>());
  const headerHRef = useRef<number | null>(null);
  const widthRef = useRef(0);
  /** Bumped whenever live measurements change, to re-derive offsets. */
  const [measureEpoch, setMeasureEpoch] = useState(0);
  // Pre-measure first paint mounts a viewport-plus worth of rows; the mount
  // effect corrects the range as soon as the scroller is known.
  const [range, setRange] = useState({ start: 0, end: 39 });

  const headerAt = useMemo(() => computeHeaderAt(items, bucketKey), [items, bucketKey]);
  const ids = useMemo(() => items.map((it) => it.id), [items]);
  const idIndex = useMemo(() => {
    const m = new Map<string, number>();
    ids.forEach((id, i) => m.set(id, i));
    return m;
  }, [ids]);

  const layout = useMemo(() => {
    void measureEpoch; // re-derive when the measure pass records new heights
    const headerH = headerHRef.current ?? HEADER_ESTIMATE;
    return { offsets: computeOffsets(ids, headerAt, heightsRef.current, headerH), headerH };
  }, [ids, headerAt, measureEpoch]);

  // Latest values for event handlers/effects without re-subscribing.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  const updateRange = useCallback(() => {
    const scroller = scrollerRef.current;
    const wrap = wrapRef.current;
    if (!scroller || !wrap) return;
    const { offsets } = layoutRef.current;
    const count = offsets.length - 1;
    if (count <= 0) return;
    const viewTop = scroller.scrollTop - wrapperTop(scroller, wrap);
    const first = indexAt(offsets, viewTop);
    const last = indexAt(offsets, viewTop + scroller.clientHeight);
    const start = Math.max(0, first - overscan);
    const end = Math.min(count - 1, last + overscan);
    setRange((r) => (r.start === start && r.end === end ? r : { start, end }));
  }, [overscan]);
  const updateRangeRef = useRef(updateRange);
  updateRangeRef.current = updateRange;

  // Find the scroll container once, then follow scrolls (rAF-throttled) and
  // scroller/content resizes.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let el: HTMLElement | null = wrap.parentElement;
    while (el) {
      const overflowY = getComputedStyle(el).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') break;
      el = el.parentElement;
    }
    scrollerRef.current = el;
    if (!el) return;
    const scroller = el;
    // Native scroll anchoring must be off for the WHOLE scroller, not just the
    // wrapper: with the rows excluded (the wrapper's overflow-anchor:none), the
    // load-more button after the list would be the only anchor candidate left,
    // and appending a page of threads would drag the viewport to the new
    // bottom. The manual compensation in the measure pass is the one authority.
    const prevAnchor = scroller.style.overflowAnchor;
    scroller.style.overflowAnchor = 'none';
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        updateRangeRef.current();
      });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => updateRangeRef.current());
    ro.observe(scroller);
    ro.observe(wrap);
    updateRangeRef.current();
    return () => {
      scroller.style.overflowAnchor = prevAnchor;
      scroller.removeEventListener('scroll', onScroll);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // On list changes: drop measurements for departed ids and re-clamp the window.
  useLayoutEffect(() => {
    const live = new Set(ids);
    const heights = heightsRef.current;
    for (const id of heights.keys()) {
      if (!live.has(id)) heights.delete(id);
    }
    updateRangeRef.current();
  }, [ids]);

  // ── Render plan ──────────────────────────────────────────────────────────────
  // Mounted indices = window ∪ pins (first, last, and cursor/open ±1), grouped
  // into consecutive runs separated by exact-height spacers.
  const start = Math.max(0, Math.min(range.start, n - 1));
  const end = Math.min(range.end, n - 1);
  const pinIdx: number[] = [0, n - 1];
  for (const pid of pinnedIds ?? []) {
    if (!pid) continue;
    const idx = idIndex.get(pid);
    if (idx == null) continue;
    pinIdx.push(idx - 1, idx, idx + 1);
  }
  const extra = pinIdx
    .filter((i) => i >= 0 && i < n && (i < start || i > end))
    .sort((a, b) => a - b);
  const runs: Array<[number, number]> = [];
  const pushRun = (a: number, b: number) => {
    const lastRun = runs[runs.length - 1];
    if (lastRun && a <= lastRun[1] + 1) lastRun[1] = Math.max(lastRun[1], b);
    else runs.push([a, b]);
  };
  for (const i of extra) if (i < start) pushRun(i, i);
  pushRun(start, end);
  for (const i of extra) if (i > end) pushRun(i, i);

  const { offsets, headerH } = layout;
  const children: ReactNode[] = [];
  const slots: Slot[] = [];
  let prevEnd = -1;
  for (const [a, b] of runs) {
    if (b < a) continue; // empty list
    // A run that starts mid-bucket synthesizes its governing header just above
    // its first row (deducted from the spacer so total height stays exact) —
    // that keeps the sticky current-bucket header pinned at the top even when
    // the header's natural row is far outside the window.
    const synthesize = a > 0 && headerAt[a] == null;
    const spacer =
      offsets[a] - (prevEnd < 0 ? 0 : offsets[prevEnd + 1]) - (synthesize ? headerH : 0);
    if (spacer > EPSILON) {
      children.push(<div key={prevEnd < 0 ? 'sp:top' : `sp:${items[a].id}`} aria-hidden style={{ height: spacer }} />);
      slots.push({ kind: 'spacer' });
    }
    if (synthesize) {
      children.push(<Fragment key={`sh:${items[a].id}`}>{renderHeader(bucketKey(items[a]))}</Fragment>);
      slots.push({ kind: 'header' });
    }
    for (let i = a; i <= b; i++) {
      const item = items[i];
      const header = headerAt[i];
      children.push(
        <Fragment key={item.id}>
          {header != null && renderHeader(header)}
          {renderRow(item)}
        </Fragment>,
      );
      if (header != null) slots.push({ kind: 'header' });
      slots.push({ kind: 'row', id: item.id });
    }
    prevEnd = b;
  }
  const tail = offsets[n] - (prevEnd < 0 ? 0 : offsets[prevEnd + 1]);
  if (tail > EPSILON) {
    children.push(<div key="sp:tail" aria-hidden style={{ height: tail }} />);
    slots.push({ kind: 'spacer' });
  }
  const slotsRef = useRef(slots);
  slotsRef.current = slots;

  // Measure pass — after every commit, read the real heights of what mounted;
  // when they differ from the book-keeping, compensate scrollTop for growth
  // above the viewport (so nothing visibly shifts) and re-derive offsets.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const width = wrap.clientWidth;
    // Hidden pane (e.g. the list is display:none on mobile while a thread is
    // open): every rect reads 0 — measuring now would poison the cache.
    if (width === 0) return;
    if (widthRef.current !== width) {
      // Width changes re-wrap row content, so cached heights are stale.
      const firstMeasure = widthRef.current === 0;
      widthRef.current = width;
      if (!firstMeasure) {
        heightsRef.current.clear();
        headerHRef.current = null;
      }
    }
    const currentSlots = slotsRef.current;
    const kids = wrap.children;
    if (kids.length !== currentSlots.length) return;
    const heights = heightsRef.current;
    let dirty = false;
    for (let k = 0; k < currentSlots.length; k++) {
      const slot = currentSlots[k];
      if (slot.kind === 'spacer') continue;
      const h = (kids[k] as HTMLElement).getBoundingClientRect().height;
      if (slot.kind === 'header') {
        if (headerHRef.current == null || Math.abs(headerHRef.current - h) > EPSILON) {
          headerHRef.current = h;
          dirty = true;
        }
      } else {
        const old = heights.get(slot.id);
        if (old == null || Math.abs(old - h) > EPSILON) {
          heights.set(slot.id, h);
          dirty = true;
        }
      }
    }
    if (!dirty) return;
    const scroller = scrollerRef.current;
    if (scroller) {
      const oldOffsets = layoutRef.current.offsets;
      const newOffsets = computeOffsets(
        ids,
        headerAt,
        heights,
        headerHRef.current ?? HEADER_ESTIMATE,
      );
      const viewTop = scroller.scrollTop - wrapperTop(scroller, wrap);
      if (viewTop > 0 && oldOffsets.length > 1) {
        const anchor = indexAt(oldOffsets, viewTop);
        const delta = newOffsets[anchor] - oldOffsets[anchor];
        if (Math.abs(delta) > EPSILON) scroller.scrollTop += delta;
      }
    }
    setMeasureEpoch((e) => e + 1);
  });

  // `overflow-anchor: none` keeps the browser's own scroll anchoring from
  // fighting the manual compensation above. The wrapper is a plain block with
  // no styling, so headers/rows lay out exactly as they did as direct children
  // of the scroll container.
  return (
    <div ref={wrapRef} style={{ overflowAnchor: 'none' }}>
      {children}
    </div>
  );
}

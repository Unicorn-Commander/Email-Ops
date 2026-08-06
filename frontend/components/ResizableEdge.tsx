'use client';

/**
 * ResizableEdge — the ONE shared drag-handle primitive for every resizable side
 * pane (folders column, thread list, agent rails, section nav).
 *
 * A thin vertical strip absolutely positioned on one edge of its PARENT pane:
 *
 *   • Pointer Events + capture: drag anywhere once grabbed, even across the
 *     reader's sandboxed HTML-email iframe. While dragging, a transparent
 *     full-viewport SHIELD is portaled onto <body> (portal so `backdrop-blur`
 *     ancestors can't turn `fixed` into a local containing block) — belt and
 *     suspenders on top of pointer capture so iframes never eat pointermove.
 *   • rAF-batched: at most one width update per frame, applied by the parent as
 *     an inline width / grid-column — no layout thrash, no transitions fighting
 *     the pointer (parents drop their width transition via onDraggingChange).
 *   • Clamped to the pane's [min,max]; widths persist through the pane's
 *     PaneWidthStore (preview during drag, one localStorage write on release).
 *   • Double-click (or Enter) resets to the design default and clears the key.
 *   • Keyboard accessible: role="separator", arrow keys nudge ±16px, Home/End
 *     jump to min/max.
 *   • 12px hit strip (kept inside the pane so it never covers the neighbor's
 *     scrollbar or row controls) with an 8px accent pill + 2px core line on
 *     hover / focus / drag; cursor col-resize; hidden below lg where the panes
 *     stack or overlay.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/components/ui';
import type { PaneWidthStore } from '@/state/paneWidths';

export interface ResizableEdgeProps {
  /** Width store this handle reads/writes (bounds + persistence). */
  store: PaneWidthStore;
  /** Which edge of the handle's PARENT element the strip hugs. */
  edge: 'left' | 'right';
  /**
   * Which element's width the drag changes:
   *   'parent'       — the handle's own pane (rails resized from their left
   *                    edge, the section nav from its right edge);
   *   'prev-sibling' — the pane BEFORE the handle's parent (used when the
   *                    resized pane's own edge is busy — e.g. the folders
   *                    column scrolls under its right edge, so its handle
   *                    lives on the left edge of the list section).
   */
  target?: 'parent' | 'prev-sibling';
  /** Accessible name, e.g. "Resize folders pane". */
  label: string;
  /** Fires true on grab / false on release (parents pause width transitions). */
  onDraggingChange?: (dragging: boolean) => void;
  className?: string;
}

interface DragState {
  pointerId: number;
  startX: number;
  startWidth: number;
  lastWidth: number;
  /** True once a frame actually changed the width — a no-op click (or the
      first half of a double-click) must not pin a fluid pane to px. */
  moved: boolean;
}

export function ResizableEdge({
  store,
  edge,
  target = 'parent',
  label,
  onDraggingChange,
  className,
}: ResizableEdgeProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const drag = useRef<DragState | null>(null);
  const frame = useRef<number | null>(null);
  const pendingX = useRef(0);
  const [dragging, setDragging] = useState(false);
  const override = store.use();

  // +dx grows the pane when it sits LEFT of this edge (prev-sibling, or the
  // parent's own right edge); a right-hand rail grabbed by its left edge grows
  // as the pointer moves LEFT.
  const sign = target === 'prev-sibling' || edge === 'right' ? 1 : -1;

  const paneEl = useCallback((): HTMLElement | null => {
    const parent = ref.current?.parentElement;
    if (!parent) return null;
    if (target === 'parent') return parent;
    const prev = parent.previousElementSibling;
    return prev instanceof HTMLElement ? prev : null;
  }, [target]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      const pane = paneEl();
      if (!pane) return;
      event.preventDefault();
      ref.current?.setPointerCapture(event.pointerId);
      const startWidth = pane.getBoundingClientRect().width;
      drag.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth,
        lastWidth: store.clamp(startWidth),
        moved: false,
      };
      pendingX.current = event.clientX;
      setDragging(true);
    },
    [paneEl, store],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = drag.current;
      if (!state || event.pointerId !== state.pointerId) return;
      pendingX.current = event.clientX;
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        const live = drag.current;
        if (!live) return;
        const next = store.clamp(
          live.startWidth + sign * (pendingX.current - live.startX),
        );
        if (next !== live.lastWidth) {
          live.lastWidth = next;
          live.moved = true;
          store.preview(next);
        }
      });
    },
    [sign, store],
  );

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const state = drag.current;
      if (!state || event.pointerId !== state.pointerId) return;
      drag.current = null;
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
      try {
        ref.current?.releasePointerCapture(event.pointerId);
      } catch {
        // Capture already released (e.g. pointercancel) — fine.
      }
      if (state.moved) store.set(state.lastWidth);
      setDragging(false);
    },
    [store],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        store.reset();
        return;
      }
      const pane = paneEl();
      if (!pane) return;
      const current = override ?? pane.getBoundingClientRect().width;
      let next: number | null = null;
      if (event.key === 'ArrowRight') next = store.clamp(current + sign * 16);
      else if (event.key === 'ArrowLeft') next = store.clamp(current - sign * 16);
      else if (event.key === 'Home') next = store.min;
      else if (event.key === 'End') next = store.max;
      if (next === null) return;
      event.preventDefault();
      store.set(next);
    },
    [override, paneEl, sign, store],
  );

  // While dragging: kill text selection + force the resize cursor globally, and
  // tell the parent to pause its width transition. Effect-scoped so release,
  // pointercancel AND unmount-mid-drag all restore cleanly.
  useEffect(() => {
    if (!dragging) return;
    onDraggingChange?.(true);
    const { body } = document;
    const prevUserSelect = body.style.userSelect;
    const prevCursor = body.style.cursor;
    body.style.userSelect = 'none';
    body.style.cursor = 'col-resize';
    return () => {
      body.style.userSelect = prevUserSelect;
      body.style.cursor = prevCursor;
      onDraggingChange?.(false);
    };
  }, [dragging, onDraggingChange]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const valueNow = override ?? store.defaultWidth ?? undefined;

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={store.min}
      aria-valuemax={store.max}
      aria-valuenow={valueNow}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => store.reset()}
      onKeyDown={onKeyDown}
      className={cn(
        'group absolute inset-y-0 z-30 hidden w-3 cursor-col-resize touch-none select-none focus-visible:outline-none lg:block',
        edge === 'right' ? 'right-0' : 'left-0',
        className,
      )}
    >
      {/* 8px affordance pill hugging the boundary — hover / focus / drag. */}
      <span
        aria-hidden
        className={cn(
          'absolute inset-y-0 w-2 opacity-0 transition-opacity duration-fast ease-token',
          'bg-accent/15 group-hover:opacity-100 group-focus-visible:opacity-100',
          edge === 'right' ? 'right-0' : 'left-0',
          dragging && 'bg-accent/25 opacity-100',
        )}
      />
      {/* 2px core line on the exact boundary. */}
      <span
        aria-hidden
        className={cn(
          'absolute inset-y-0 w-[2px] bg-accent opacity-0 transition-opacity duration-fast ease-token',
          'group-hover:opacity-70 group-focus-visible:opacity-90',
          edge === 'right' ? 'right-0' : 'left-0',
          dragging && 'opacity-100',
        )}
      />
      {/* Full-viewport transparent shield while dragging: the reader renders
          HTML email in a sandboxed iframe that would otherwise swallow
          pointermove. Portaled to <body> so ancestor backdrop-filters can't
          clip the fixed positioning. */}
      {dragging
        ? createPortal(
            <div aria-hidden className="fixed inset-0 z-[200] cursor-col-resize" />,
            document.body,
          )
        : null}
    </div>
  );
}

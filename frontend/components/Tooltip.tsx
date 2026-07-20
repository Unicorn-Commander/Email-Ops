'use client';

/**
 * Tooltip — the ONE shared hover/focus explainer primitive for the app.
 *
 * Wraps a single trigger element (usually an icon-only button) and shows a
 * small bubble after a short delay:
 *
 *   • Shows on pointer hover AND keyboard focus (`:focus-visible` only, so a
 *     mouse click or touch tap never flashes it); hides on leave/blur/Escape
 *     and on pointerdown (the action answers the question).
 *   • Touch: pointerType 'touch' is ignored entirely — tooltips simply don't
 *     show on touch devices (the Help page documents every control instead).
 *   • Accessible: the bubble is `role="tooltip"` and wired to the trigger via
 *     `aria-describedby` while visible; Escape dismisses without blurring.
 *   • Positioned `fixed` with simple viewport-aware collision handling: the
 *     preferred side flips when there's no room, and the bubble clamps inside
 *     the viewport horizontally/vertically. Repositions on scroll + resize.
 *   • Never traps the pointer (`pointer-events-none` on the bubble), renders
 *     through a portal so `overflow:hidden` ancestors can't clip it, and is
 *     SSR-safe (the portal only exists after a client-side open).
 *   • Content is a short string or small rich node; theme-aware via tokens.
 *
 * No external deps. When the child is not a single React element it is wrapped
 * in an inline-flex span so the handlers have something to attach to.
 */

import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/components/ui';

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

/** The handler/aria props merged onto the trigger element. */
interface TriggerProps {
  onPointerEnter?: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerLeave?: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
  onFocus?: (event: ReactFocusEvent<HTMLElement>) => void;
  onBlur?: (event: ReactFocusEvent<HTMLElement>) => void;
  'aria-describedby'?: string;
}

export interface TooltipProps {
  /** Short explainer (string or a small rich node). Empty/false → no tooltip. */
  content: ReactNode;
  /** Preferred bubble side; flips automatically when out of room. */
  side?: TooltipSide;
  /** Hover delay in ms (focus shows faster). */
  delay?: number;
  /** Render the trigger without any tooltip behavior. */
  disabled?: boolean;
  children: ReactNode;
  /** Extra classes for the bubble (e.g. a wider max-w for rich content). */
  bubbleClassName?: string;
}

const GAP = 7;
const EDGE = 8;
const FOCUS_DELAY = 80;

interface Placement {
  left: number;
  top: number;
}

function place(
  anchor: DOMRect,
  bubble: { width: number; height: number },
  side: TooltipSide,
): Placement {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Flip the preferred side when there's no room on it but there is opposite.
  let s = side;
  if (s === 'top' && anchor.top - bubble.height - GAP < EDGE) s = 'bottom';
  else if (s === 'bottom' && anchor.bottom + bubble.height + GAP > vh - EDGE) s = 'top';
  else if (s === 'left' && anchor.left - bubble.width - GAP < EDGE) s = 'right';
  else if (s === 'right' && anchor.right + bubble.width + GAP > vw - EDGE) s = 'left';

  let left: number;
  let top: number;
  if (s === 'top' || s === 'bottom') {
    left = anchor.left + anchor.width / 2 - bubble.width / 2;
    top = s === 'top' ? anchor.top - bubble.height - GAP : anchor.bottom + GAP;
  } else {
    top = anchor.top + anchor.height / 2 - bubble.height / 2;
    left = s === 'left' ? anchor.left - bubble.width - GAP : anchor.right + GAP;
  }

  // Clamp inside the viewport (never off-screen, whatever the flip decided).
  left = Math.min(Math.max(left, EDGE), Math.max(EDGE, vw - bubble.width - EDGE));
  top = Math.min(Math.max(top, EDGE), Math.max(EDGE, vh - bubble.height - EDGE));
  return { left, top };
}

export function Tooltip({
  content,
  side = 'top',
  delay = 350,
  disabled = false,
  children,
  bubbleClassName,
}: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Placement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const hide = useCallback(() => {
    clearTimer();
    setOpen(false);
    setPos(null);
  }, [clearTimer]);

  const scheduleShow = useCallback(
    (anchor: HTMLElement, wait: number) => {
      clearTimer();
      anchorRef.current = anchor;
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setOpen(true);
      }, wait);
    },
    [clearTimer],
  );

  // Measure + place once the bubble exists, then track scroll/resize while open.
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const anchor = anchorRef.current;
      const bubble = bubbleRef.current;
      if (!anchor || !bubble) return;
      if (!anchor.isConnected) {
        hide();
        return;
      }
      const rect = anchor.getBoundingClientRect();
      setPos(place(rect, { width: bubble.offsetWidth, height: bubble.offsetHeight }, side));
    };
    update();
    window.addEventListener('scroll', update, { capture: true, passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, { capture: true });
      window.removeEventListener('resize', update);
    };
  }, [open, side, hide]);

  // Escape dismisses (without stealing focus) while visible.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, hide]);

  useEffect(() => clearTimer, [clearTimer]);

  const active = !disabled && content !== null && content !== undefined && content !== false && content !== '';

  const triggerProps: TriggerProps | null = active
    ? {
        onPointerEnter: (event) => {
          if (event.pointerType === 'touch') return; // touch: never show
          scheduleShow(event.currentTarget, delay);
        },
        onPointerLeave: () => hide(),
        onPointerDown: () => hide(),
        onFocus: (event) => {
          const el = event.currentTarget;
          let keyboard = true;
          try {
            keyboard = el.matches(':focus-visible');
          } catch {
            // :focus-visible unsupported → show on any focus (safe fallback).
          }
          if (keyboard) scheduleShow(el, FOCUS_DELAY);
        },
        onBlur: () => hide(),
        ...(open ? { 'aria-describedby': id } : {}),
      }
    : null;

  let trigger: ReactNode;
  if (!triggerProps) {
    trigger = children;
  } else if (isValidElement<TriggerProps>(children)) {
    const prev = children.props;
    trigger = cloneElement(children, {
      onPointerEnter: (e: ReactPointerEvent<HTMLElement>) => {
        prev.onPointerEnter?.(e);
        triggerProps.onPointerEnter?.(e);
      },
      onPointerLeave: (e: ReactPointerEvent<HTMLElement>) => {
        prev.onPointerLeave?.(e);
        triggerProps.onPointerLeave?.(e);
      },
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
        prev.onPointerDown?.(e);
        triggerProps.onPointerDown?.(e);
      },
      onFocus: (e: ReactFocusEvent<HTMLElement>) => {
        prev.onFocus?.(e);
        triggerProps.onFocus?.(e);
      },
      onBlur: (e: ReactFocusEvent<HTMLElement>) => {
        prev.onBlur?.(e);
        triggerProps.onBlur?.(e);
      },
      'aria-describedby':
        [prev['aria-describedby'], open ? id : undefined].filter(Boolean).join(' ') || undefined,
    });
  } else {
    trigger = (
      <span className="inline-flex" {...triggerProps}>
        {children}
      </span>
    );
  }

  return (
    <>
      {trigger}
      {active && open
        ? createPortal(
            <div
              ref={bubbleRef}
              id={id}
              role="tooltip"
              style={
                pos
                  ? { left: pos.left, top: pos.top }
                  : { left: 0, top: 0, visibility: 'hidden' }
              }
              className={cn(
                'eops-rise-in pointer-events-none fixed z-[160] max-w-[264px] rounded-lg border border-border bg-surface-elevated px-2.5 py-1.5 text-[12px] font-normal leading-[1.45] text-primary shadow-token-lg',
                bubbleClassName,
              )}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

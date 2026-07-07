'use client';

/**
 * ⌘K command palette — a Superhuman/Linear-grade launcher for the Email-Ops
 * command center. Fully keyboard-driven: type to fuzzy-filter, ↑/↓ to move
 * (wrap-around), ↵ to run the highlighted action, Esc to close (Radix default).
 *
 * It's a pure, self-contained surface: the page owns the action list and each
 * action's `run()` — the palette just filters, ranks, renders, and dispatches.
 *
 * Chrome-less by design, so it uses the raw Radix Dialog (`DialogPrimitive`,
 * re-exported from `@/components/ui`) rather than the titled `Dialog` wrapper —
 * but reuses the SAME overlay/animation conventions (`lo-dialog-overlay` fade,
 * `eops-rise-in` content rise), both auto-neutralized under reduced-motion by
 * the global guard in globals.css. Themed for dark + light via design tokens.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { DialogPrimitive, cn } from '@/components/ui';

export interface CommandAction {
  id: string;
  label: string;
  /** Section header this action files under, e.g. "Navigate", "Actions", "Agent". */
  group: string;
  /** Right-aligned shortcut hint, e.g. "E", "⌘⇧A". */
  hint?: string;
  icon?: ReactNode;
  /** Extra text folded into the fuzzy match (synonyms, aliases). */
  keywords?: string;
  disabled?: boolean;
  /** Executed on select; the palette closes right after. */
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: CommandAction[];
  /** Default: "Type a command or search…" */
  placeholder?: string;
}

/* ---------------------------------------------------------------- scoring -- */

/**
 * Lightweight inline scorer — no external fuzzy lib. Returns a number where
 * higher is a better match, or `null` for no match at all. Ranking, best→worst:
 * exact prefix › word-start substring › substring › subsequence (fewer gaps
 * better). Case-insensitive.
 */
function fuzzyScore(text: string, needle: string): number | null {
  if (!needle) return 0;
  const hay = text.toLowerCase();

  const idx = hay.indexOf(needle);
  if (idx !== -1) {
    let score = 1000 - Math.min(idx, 500); // earlier hits rank higher
    if (idx === 0) score += 1000; // exact prefix
    else if (/[\s/([-]/.test(hay[idx - 1] ?? '')) score += 500; // word-start
    return score;
  }

  // Subsequence: every needle char appears in order somewhere in the haystack.
  let cursor = 0;
  let gaps = 0;
  let last = -1;
  for (const ch of needle) {
    const found = hay.indexOf(ch, cursor);
    if (found === -1) return null;
    if (last !== -1) gaps += found - last - 1;
    last = found;
    cursor = found + 1;
  }
  return 250 - Math.min(gaps, 250);
}

/**
 * Score an action against the query. Weights a hit in the label above one that
 * only lands in the group/keywords, so the most literal command wins.
 */
function scoreAction(action: CommandAction, needle: string): number | null {
  if (!needle) return 0;
  const label = fuzzyScore(action.label, needle);
  const meta = fuzzyScore(
    `${action.label} ${action.group} ${action.keywords ?? ''}`,
    needle,
  );
  if (label === null && meta === null) return null;
  return (label !== null ? label + 2000 : 0) + (meta ?? 0);
}

/* ------------------------------------------------------------------- view -- */

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[18px] items-center justify-center rounded-[5px] border border-border bg-surface-overlay px-1.5 py-px text-[11px] leading-none text-secondary mono">
      {children}
    </kbd>
  );
}

function SearchIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px] shrink-0 text-tertiary"
    >
      <circle cx={11} cy={11} r={7} />
      <path d="m20 20-3.2-3.2" />
    </svg>
  );
}

export function CommandPalette({
  open,
  onOpenChange,
  actions,
  placeholder = 'Type a command or search…',
}: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<string, HTMLElement>>(new Map());

  // Fresh state every time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
    }
  }, [open]);

  // Grouped, ranked results (includes disabled actions so they still render,
  // dimmed) — group order follows first appearance in `actions`, items within a
  // group sort by score.
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const order: string[] = [];
    const buckets = new Map<string, { action: CommandAction; score: number }[]>();

    for (const action of actions) {
      const score = scoreAction(action, needle);
      if (score === null) continue;
      let bucket = buckets.get(action.group);
      if (!bucket) {
        bucket = [];
        buckets.set(action.group, bucket);
        order.push(action.group);
      }
      bucket.push({ action, score });
    }

    return order.map((name) => ({
      name,
      items: (buckets.get(name) ?? [])
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.action),
    }));
  }, [actions, query]);

  // Flat list of *navigable* (enabled) actions in visual order — this is what
  // ↑/↓ and Enter operate over. A parallel id→navIndex map wires hover + render.
  const { flat, navIndexById } = useMemo(() => {
    const list: CommandAction[] = [];
    const byId = new Map<string, number>();
    for (const group of groups) {
      for (const item of group.items) {
        if (item.disabled) continue;
        byId.set(item.id, list.length);
        list.push(item);
      }
    }
    return { flat: list, navIndexById: byId };
  }, [groups]);

  // Keep the highlight in range as results change under the cursor.
  const safeIndex = flat.length === 0 ? 0 : Math.min(activeIndex, flat.length - 1);
  const active = flat[safeIndex];
  const activeId = active?.id;

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    if (!open || !activeId) return;
    itemRefs.current.get(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId, open]);

  function move(delta: number) {
    setActiveIndex((i) => {
      const n = flat.length;
      if (n === 0) return 0;
      const base = Math.min(i, n - 1);
      return (base + delta + n) % n;
    });
  }

  function runAction(action: CommandAction | undefined) {
    if (!action || action.disabled) return;
    action.run();
    onOpenChange(false);
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter') {
      if (e.nativeEvent.isComposing) return; // don't fire mid-IME
      e.preventDefault();
      runAction(active);
    }
  }

  const hasResults = flat.length > 0 || groups.length > 0;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="lo-dialog-overlay fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <DialogPrimitive.Content
          aria-label="Command palette"
          onOpenAutoFocus={(e) => {
            // Land focus straight in the search box, not on the panel.
            e.preventDefault();
            inputRef.current?.focus();
          }}
          className="fixed left-1/2 top-[15vh] z-50 w-[calc(100vw-2rem)] max-w-[560px] -translate-x-1/2 focus:outline-none"
        >
          {/* sr-only title/description keep Radix's a11y contract happy. */}
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Search for a command and run it with the keyboard.
          </DialogPrimitive.Description>

          <div className="eops-rise-in overflow-hidden rounded-token-lg border border-border bg-surface-elevated shadow-pop">
            {/* Search row */}
            <div className="flex items-center gap-2.5 border-b border-subtle px-4">
              <SearchIcon />
              <input
                ref={inputRef}
                type="text"
                role="combobox"
                aria-expanded
                aria-controls="eops-cmdk-list"
                aria-autocomplete="list"
                aria-activedescendant={activeId ? `eops-cmdk-opt-${activeId}` : undefined}
                aria-label="Search commands"
                value={query}
                placeholder={placeholder}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                className="h-12 w-full bg-transparent text-[15px] text-primary placeholder:text-muted focus:outline-none"
              />
            </div>

            {/* Results */}
            <div
              id="eops-cmdk-list"
              role="listbox"
              aria-label="Commands"
              className="max-h-[min(56vh,420px)] overflow-y-auto overscroll-contain py-1.5"
            >
              {!hasResults ? (
                <div className="px-4 py-8 text-center text-sm text-muted">
                  No matching commands
                </div>
              ) : (
                groups.map((group) => (
                  <div key={group.name} className="mb-1 last:mb-0">
                    <div className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-tertiary">
                      {group.name}
                    </div>
                    {group.items.map((item) => {
                      const isActive = item.id === activeId;
                      const navIndex = navIndexById.get(item.id);
                      return (
                        <div
                          key={item.id}
                          id={`eops-cmdk-opt-${item.id}`}
                          ref={(el) => {
                            if (el) itemRefs.current.set(item.id, el);
                            else itemRefs.current.delete(item.id);
                          }}
                          role="option"
                          aria-selected={isActive}
                          aria-disabled={item.disabled || undefined}
                          onMouseMove={() => {
                            if (navIndex !== undefined && navIndex !== safeIndex) {
                              setActiveIndex(navIndex);
                            }
                          }}
                          onClick={() => runAction(item)}
                          className={cn(
                            'mx-1.5 flex items-center gap-3 rounded-token px-2.5 py-2 text-sm transition-colors duration-fast ease-token',
                            item.disabled
                              ? 'cursor-not-allowed text-muted'
                              : 'cursor-pointer',
                            !item.disabled && isActive
                              ? 'bg-accent/10 text-primary'
                              : !item.disabled && 'text-secondary',
                          )}
                        >
                          {/* Accent rail on the active row */}
                          <span
                            aria-hidden
                            className={cn(
                              'h-4 w-0.5 shrink-0 rounded-full',
                              isActive && !item.disabled ? 'bg-accent' : 'bg-transparent',
                            )}
                          />
                          {/* Icon slot — fixed size, holds alignment even when empty */}
                          <span
                            aria-hidden
                            className={cn(
                              'flex h-5 w-5 shrink-0 items-center justify-center [&>svg]:h-[18px] [&>svg]:w-[18px]',
                              isActive && !item.disabled ? 'text-accent' : 'text-tertiary',
                            )}
                          >
                            {item.icon}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{item.label}</span>
                          {item.hint ? (
                            <span className="shrink-0">
                              <Kbd>{item.hint}</Kbd>
                            </span>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>

            {/* Footer legend */}
            <div className="flex items-center gap-3 border-t border-subtle px-4 py-2 text-[11px] text-tertiary">
              <span className="flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
                <span className="ml-0.5">navigate</span>
              </span>
              <span className="flex items-center gap-1">
                <Kbd>↵</Kbd>
                <span className="ml-0.5">select</span>
              </span>
              <span className="ml-auto flex items-center gap-1">
                <Kbd>esc</Kbd>
                <span className="ml-0.5">close</span>
              </span>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

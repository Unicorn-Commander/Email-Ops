'use client';

/**
 * Debounced full-text search input above the thread list. Wired to the Wave-2
 * `q` param (single-mailbox and All-inboxes modes both). `/` focuses it.
 */

import { forwardRef, useEffect, useRef, useState } from 'react';
import { cn } from '@/components/ui';

export const SearchBar = forwardRef<
  HTMLInputElement,
  {
    /** The committed (already-applied) query, so external clears sync back. */
    query: string;
    onQuery: (q: string) => void;
    placeholder?: string;
    className?: string;
  }
>(function SearchBar({ query, onQuery, placeholder, className }, ref) {
  const [draft, setDraft] = useState(query);
  const timerRef = useRef<number | null>(null);
  const onQueryRef = useRef(onQuery);
  onQueryRef.current = onQuery;

  // External resets (mailbox/folder switches clear the search) sync down.
  useEffect(() => {
    setDraft(query);
  }, [query]);

  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    },
    [],
  );

  function schedule(next: string) {
    setDraft(next);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => onQueryRef.current(next), 300);
  }

  function clear() {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    setDraft('');
    onQueryRef.current('');
  }

  return (
    <div className={cn('relative', className)}>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
      >
        <path
          d="M21 21l-4.3-4.3M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
        />
      </svg>
      <input
        ref={ref}
        value={draft}
        onChange={(e) => schedule(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            clear();
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder={placeholder ?? 'Search mail…  ( / )'}
        autoComplete="off"
        spellCheck={false}
        className={cn(
          'block w-full rounded-token border border-border bg-surface-base py-1.5 pl-8 pr-8 text-sm text-primary placeholder:text-muted',
          'transition-colors duration-fast ease-token focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40',
        )}
      />
      {draft && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={clear}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-tertiary transition-colors duration-fast ease-token hover:bg-surface-overlay hover:text-primary"
        >
          <svg viewBox="0 0 24 24" fill="none" className="h-3.5 w-3.5" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
});

'use client';

/**
 * Token-chip recipient input (To / Cc / Bcc).
 *
 * Typing then comma/Enter/blur commits a chip; pasting splits on commas,
 * semicolons, and whitespace; Backspace on an empty input pops the last chip;
 * every chip has a click-× remove. Chips that fail basic email validation
 * render in the danger tone (and callers should block send while any exist).
 */

import { useEffect, useRef, useState, type KeyboardEvent, type ClipboardEvent } from 'react';
import { cn } from '@/components/ui';
import { searchMailContacts, type MailContact } from '@/lib/mailApi';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(s: string): boolean {
  return EMAIL_RE.test(s.trim());
}

/** Split free text into address candidates (paste / commit). Supports "Name <a@b>". */
function splitAddresses(text: string): string[] {
  return text
    .split(/[,;\n]+/)
    .map((part) => {
      const angled = part.match(/<([^<>\s]+@[^<>\s]+)>/);
      return (angled ? angled[1] : part).trim();
    })
    .filter(Boolean);
}

export function RecipientChips({
  value,
  onChange,
  placeholder,
  autoFocus,
  disabled,
  workspaceId,
  mailboxId,
  'aria-label': ariaLabel,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  workspaceId?: string | null;
  mailboxId?: string | null;
  'aria-label'?: string;
}) {
  const [draft, setDraft] = useState('');
  const [suggestions, setSuggestions] = useState<MailContact[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!workspaceId || !mailboxId || draft.trim().length < 1) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      void (async () => {
        try {
          const res = await searchMailContacts(workspaceId, mailboxId, draft);
          if (!alive) return;
          const picked = new Set(value.map((v) => v.toLowerCase()));
          const next = res.items.filter((c) => !picked.has(c.email.toLowerCase()));
          setSuggestions(next);
          setActive(0);
          setOpen(next.length > 0);
        } catch {
          if (alive) {
            setSuggestions([]);
            setOpen(false);
          }
        }
      })();
    }, 160);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [workspaceId, mailboxId, draft, value]);

  function commit(text: string) {
    const parts = splitAddresses(text);
    if (parts.length === 0) return;
    const seen = new Set(value.map((v) => v.toLowerCase()));
    const next = [...value];
    for (const p of parts) {
      if (!seen.has(p.toLowerCase())) {
        next.push(p);
        seen.add(p.toLowerCase());
      }
    }
    onChange(next);
    setDraft('');
    setOpen(false);
  }

  function commitContact(contact: MailContact) {
    commit(contact.email);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (open && suggestions.length > 0 && e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (open && suggestions.length > 0 && e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (open && suggestions.length > 0 && (e.key === 'Enter' || e.key === 'Tab')) {
      e.preventDefault();
      commitContact(suggestions[active] ?? suggestions[0]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      if (draft.trim()) {
        e.preventDefault();
        commit(draft);
      } else if (e.key !== 'Enter') {
        e.preventDefault(); // swallow stray separators
      }
      // Empty draft + Enter falls through (lets a form submit if it wants to).
    } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text');
    if (/[,;\n]|<.*@.*>/.test(text)) {
      e.preventDefault();
      commit(draft + text);
    }
  }

  return (
    <div className="relative">
      <div
        onClick={() => inputRef.current?.focus()}
        className={cn(
          'flex min-h-[44px] w-full cursor-text flex-wrap items-center gap-1 rounded-token border border-border bg-surface-base px-2 py-1.5 sm:min-h-[36px]',
          'transition-colors duration-fast ease-token focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/40',
          disabled && 'pointer-events-none opacity-50',
        )}
      >
        {value.map((addr) => {
          const valid = isValidEmail(addr);
          return (
            <span
              key={addr}
              className={cn(
                'inline-flex max-w-full items-center gap-1 rounded-token px-1.5 py-0.5 text-xs font-medium leading-5',
                valid ? 'bg-surface-overlay text-secondary' : 'bg-danger-subtle text-danger',
              )}
              title={valid ? addr : `${addr} — not a valid address`}
            >
              <span className="min-w-0 truncate">{addr}</span>
              <button
                type="button"
                aria-label={`Remove ${addr}`}
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(value.filter((v) => v !== addr));
                }}
                className="shrink-0 rounded-full p-0.5 opacity-70 transition-opacity hover:opacity-100"
              >
                <svg viewBox="0 0 24 24" fill="none" className="h-3 w-3" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
                </svg>
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          onBlur={() => {
            window.setTimeout(() => setOpen(false), 120);
            if (draft.trim()) commit(draft);
          }}
          placeholder={value.length === 0 ? placeholder ?? 'name@example.com' : undefined}
          aria-label={ariaLabel}
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          inputMode="email"
          className="min-w-[10ch] flex-1 border-0 bg-transparent p-0.5 text-sm text-primary outline-none placeholder:text-muted"
        />
      </div>
      {open && suggestions.length > 0 && (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 overflow-hidden rounded-token border border-border bg-surface-elevated shadow-token">
          {suggestions.map((contact, i) => (
            <button
              key={contact.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commitContact(contact)}
              className={cn(
                'flex w-full flex-col px-3 py-2 text-left text-sm transition-colors',
                i === active ? 'bg-accent/10 text-primary' : 'text-secondary hover:bg-surface-overlay',
              )}
            >
              <span className="truncate font-medium">{contact.display_name || contact.email}</span>
              {contact.display_name && (
                <span className="truncate font-mono text-[11px] text-tertiary">{contact.email}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

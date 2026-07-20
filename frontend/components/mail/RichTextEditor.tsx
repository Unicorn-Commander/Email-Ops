'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import DOMPurify from 'dompurify';
import { cn } from '@/components/ui';
import { Tooltip } from '@/components/Tooltip';

export function htmlToText(html: string): string {
  if (typeof window === 'undefined') return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const el = window.document.createElement('div');
  el.innerHTML = DOMPurify.sanitize(html);
  return (el.textContent || el.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
}

export function RichTextEditor({
  value,
  onChange,
  disabled,
  placeholder,
  className,
}: {
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Never inject unsanitized HTML into this contentEditable — it lives in the
    // app origin (holds the session), so a malicious signature/draft/reply body
    // must not be able to execute here. DOMPurify is idempotent on the browser-
    // generated markup this editor produces, so live typing is unaffected.
    const clean = DOMPurify.sanitize(value);
    if (el.innerHTML === clean) return;
    el.innerHTML = clean;
  }, [value]);

  function command(cmd: string, arg?: string) {
    ref.current?.focus();
    document.execCommand(cmd, false, arg);
    onChange(ref.current?.innerHTML ?? '');
  }

  function link() {
    const url = window.prompt('Link URL');
    if (!url?.trim()) return;
    command('createLink', url.trim());
  }

  return (
    <div className={cn('overflow-hidden rounded-token border border-border bg-surface-base', className)}>
      <div className="flex flex-wrap items-center gap-1 border-b border-subtle bg-surface-overlay/40 px-2 py-1">
        <Tool label="Bold" onClick={() => command('bold')} disabled={disabled}>B</Tool>
        <Tool label="Italic" onClick={() => command('italic')} disabled={disabled}>I</Tool>
        <Tool label="Underline" onClick={() => command('underline')} disabled={disabled}>U</Tool>
        <Tool label="Bulleted list" onClick={() => command('insertUnorderedList')} disabled={disabled}>•</Tool>
        <Tool label="Numbered list" onClick={() => command('insertOrderedList')} disabled={disabled}>1.</Tool>
        <Tool label="Link" onClick={link} disabled={disabled}>Link</Tool>
      </div>
      <div
        ref={ref}
        contentEditable={!disabled}
        role="textbox"
        aria-multiline="true"
        data-placeholder={placeholder}
        onInput={() => onChange(ref.current?.innerHTML ?? '')}
        className="rich-editor min-h-[150px] w-full overflow-y-auto px-3 py-2 text-sm text-primary outline-none empty:before:content-[attr(data-placeholder)] empty:before:text-muted"
      />
    </div>
  );
}

function Tool({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        className="min-w-7 rounded-md px-2 py-1 text-xs font-semibold text-secondary transition-colors hover:bg-surface-raised hover:text-primary disabled:opacity-50"
      >
        {children}
      </button>
    </Tooltip>
  );
}

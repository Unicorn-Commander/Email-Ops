'use client';

/**
 * The reader pop-out (locked behaviour: BOTH).
 *
 *  1. OVERLAY (default): the open message in a focused, centered window over a
 *     dimmed, blurred scrim — real title-bar treatment (traffic lights), Esc or
 *     click-away closes. The body reuses the same sanitized message rendering as
 *     the inline reader (MessageItem → HtmlEmailBody: DOMPurify + sandboxed
 *     iframe + remote-image blocking + cid resolution), so nothing regresses.
 *
 *  2. EJECT ("⏏"): one click opens the SAME message standalone in a real OS
 *     window via window.open + document.write. The written document is
 *     DOMPurify-sanitized (scripts/forms/embeds stripped) and theme-matched, so
 *     it renders readably on its own.
 */

import DOMPurify from 'dompurify';
import { useEffect, useState } from 'react';
import { cn } from '@/components/ui';
import { MessageItem } from './MessageItem';
import { participantLabel, formatWhen } from './useMailClient';
import type { MessageView } from '@/lib/mailApi';
import { CloseIcon, EjectIcon } from './icons';

/** Minimal, defense-in-depth sanitize config for the ejected standalone doc. */
const EJECT_PURIFY = {
  WHOLE_DOCUMENT: true,
  FORBID_TAGS: [
    'script', 'iframe', 'frame', 'object', 'embed', 'form', 'input',
    'textarea', 'select', 'button', 'base', 'link', 'meta', 'audio', 'video',
  ],
  FORBID_ATTR: ['srcset', 'ping', 'formaction', 'onerror', 'onload'],
};

function readToken(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v ? `rgb(${v})` : fallback;
}

/** Build + open a self-contained standalone window for the message(s). */
function ejectToWindow(subject: string, messages: MessageView[]) {
  // NB: do NOT pass noopener/noreferrer in the feature string — either token
  // forces window.open to return null, leaving a blank window that never gets
  // the document written. Sever the opener manually after opening instead.
  const win = window.open('', '_blank', 'width=780,height=880');
  if (!win) return; // popup blocked — the overlay remains available
  try {
    win.opener = null;
  } catch {
    /* opener already severed */
  }

  const bg = readToken('--surface-base', '#0b0b0e');
  const raised = readToken('--surface-raised', '#131318');
  const fg = readToken('--text-primary', '#e7e7ea');
  const muted = readToken('--text-tertiary', '#8a8a96');
  const border = readToken('--border-subtle', '#20202a');
  const accent = readToken('--accent', '#7c5cff');

  const blocks = messages
    .map((m) => {
      const who = participantLabel(m.from);
      const addr = m.from?.address ?? '';
      const when = formatWhen(m.sent_at) ?? '';
      const raw = m.html_body?.trim();
      const bodyHtml = raw
        ? DOMPurify.sanitize(raw, EJECT_PURIFY)
        : `<pre style="white-space:pre-wrap;font:inherit;margin:0">${escapeHtml(
            m.text_body ?? m.preview ?? 'No content.',
          )}</pre>`;
      return `
        <section class="msg">
          <div class="meta">
            <strong>${escapeHtml(who)}</strong>
            <span class="mono">${escapeHtml(addr)}</span>
            <span class="mono when">${escapeHtml(when)}</span>
          </div>
          <div class="body">${bodyHtml}</div>
        </section>`;
    })
    .join('');

  const doc = `<!doctype html><html><head><meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width,initial-scale=1"/>
    <title>${escapeHtml(subject || 'Message')}</title>
    <style>
      :root{color-scheme:light dark}
      *{box-sizing:border-box}
      body{margin:0;background:${bg};color:${fg};
        font:15px/1.7 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
      .mono{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-variant-numeric:tabular-nums}
      header{position:sticky;top:0;background:${raised};border-bottom:1px solid ${border};
        padding:16px 26px}
      header h1{margin:0;font-size:19px;font-weight:680;letter-spacing:-.015em}
      header .tag{display:inline-block;margin-top:6px;font-size:11px;color:${accent};
        border:1px solid ${accent};border-radius:6px;padding:1px 8px}
      main{max-width:72ch;margin:0 auto;padding:22px 26px 60px}
      .msg{border-bottom:1px solid ${border};padding:18px 0}
      .msg:last-child{border-bottom:0}
      .meta{display:flex;flex-wrap:wrap;gap:10px;align-items:baseline;margin-bottom:12px}
      .meta strong{font-size:14px;font-weight:620}
      .meta .mono{font-size:12px;color:${muted}}
      .meta .when{margin-left:auto}
      .body img{max-width:100%;height:auto}
      a{color:${accent}}
    </style></head>
    <body>
      <header><h1>${escapeHtml(subject || '(no subject)')}</h1>
        <span class="tag">Email-Ops · popped out</span></header>
      <main>${blocks}</main>
    </body></html>`;

  win.document.open();
  win.document.write(doc);
  win.document.close();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  );
}

export function MessagePopout({
  open,
  onClose,
  subject,
  messages,
  workspaceId,
  mailboxId,
}: {
  open: boolean;
  onClose: () => void;
  subject: string;
  messages: MessageView[];
  workspaceId: string | null;
  mailboxId: string | null;
}) {
  // Mount-then-show so the entrance transition (opacity/scale) actually runs.
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
    const t = setTimeout(() => setMounted(false), 200);
    return () => clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!mounted) return null;

  return (
    <>
      <button
        type="button"
        aria-label="Close popped-out message"
        onClick={onClose}
        className={cn(
          'fixed inset-0 z-40 cursor-default bg-black/50 backdrop-blur-[3px] transition-opacity duration-token ease-token',
          shown ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Popped-out message"
        className={cn(
          'fixed left-1/2 top-1/2 z-50 flex max-h-[84vh] w-[min(760px,92vw)] flex-col overflow-hidden rounded-[14px] border border-border bg-surface-raised shadow-pop transition-all duration-token ease-token',
          shown
            ? 'pointer-events-auto -translate-x-1/2 -translate-y-1/2 scale-100 opacity-100'
            : 'pointer-events-none -translate-x-1/2 -translate-y-[48%] scale-[0.97] opacity-0',
        )}
      >
        <div className="flex h-[42px] shrink-0 items-center gap-2.5 border-b border-subtle bg-surface-overlay pl-3.5 pr-2">
          <div className="flex gap-[7px]">
            <i className="block h-[11px] w-[11px] rounded-full bg-[#ff5f57]" />
            <i className="block h-[11px] w-[11px] rounded-full bg-[#febc2e]" />
            <i className="block h-[11px] w-[11px] rounded-full bg-[#28c840]" />
          </div>
          <div className="flex-1 truncate text-center text-[12px] font-semibold text-secondary">
            {subject || 'Message'}
          </div>
          <button
            type="button"
            onClick={() => ejectToWindow(subject, messages)}
            title="Eject to a standalone window"
            aria-label="Eject to a standalone window"
            className="grid h-8 w-8 place-items-center rounded-lg text-tertiary transition-colors hover:bg-accent/12 hover:text-accent"
          >
            <EjectIcon className="h-[16px] w-[16px]" />
          </button>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            aria-label="Close"
            className="grid h-8 w-8 place-items-center rounded-lg text-tertiary transition-colors hover:bg-surface-overlay hover:text-primary"
          >
            <CloseIcon className="h-[16px] w-[16px]" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {messages.length === 0 ? (
            <p className="p-6 text-center text-sm text-tertiary">No messages to show.</p>
          ) : workspaceId ? (
            <ul className="space-y-2.5">
              {messages.map((m) => (
                <MessageItem
                  key={m.id}
                  message={m}
                  workspaceId={workspaceId}
                  mailboxId={mailboxId}
                  collapsed={false}
                  onToggle={() => {}}
                />
              ))}
            </ul>
          ) : (
            <div className="space-y-4">
              {messages.map((m) => (
                <div key={m.id} className="rounded-token border border-subtle bg-surface-base/50 p-3">
                  <p className="text-sm font-medium text-primary">{participantLabel(m.from)}</p>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-secondary">
                    {m.text_body ?? m.preview ?? 'No content.'}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

'use client';

/**
 * Sanitized HTML email body, rendered in an isolated sandboxed iframe.
 *
 * Safety model (the html arrives RAW and UNSANITIZED from the backend):
 *   1. DOMPurify strips scripts/forms/embeds/event handlers (client-side only —
 *      this component renders nothing until mounted, so SSR never touches it).
 *   2. The result renders into an <iframe srcDoc> with a sandbox that has NO
 *      `allow-scripts` — even a sanitizer bypass cannot execute.
 *   3. Remote images are BLOCKED by default (src moved aside, replaced with an
 *      inert placeholder; CSS `url(http…)` neutralized) — a per-message "Show
 *      images" pill restores them, and "Always" remembers the sender in
 *      localStorage. `cid:` images resolve to authenticated blob object-URLs.
 *   4. Links get target=_blank + rel=noopener noreferrer (sandbox allows popups
 *      so they open in a new tab, escaping the sandbox cleanly).
 *
 * Quoted trailers (trailing <blockquote>s, gmail_quote / Outlook reply blocks)
 * are split out and collapsed behind a "•••" expander.
 *
 * Height auto-fits via same-origin measurement (srcDoc + allow-same-origin is
 * same-origin to us; without allow-scripts the framed content still can't run).
 */

import DOMPurify from 'dompurify';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/components/ui';
import { useTheme } from '@/state/theme';
import type { MailAttachment } from '@/lib/mailApi';

/** localStorage key: senders whose remote images are always shown. */
const TRUSTED_IMG_SENDERS_KEY = 'eops:mail:show-images-senders';

/** 1×1 transparent GIF — the inert stand-in for blocked remote images. */
const BLANK_IMG =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function loadTrustedSenders(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(TRUSTED_IMG_SENDERS_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((s): s is string => typeof s === 'string') : []);
  } catch {
    return new Set();
  }
}

function rememberTrustedSender(address: string): void {
  try {
    const set = loadTrustedSenders();
    set.add(address.toLowerCase());
    window.localStorage.setItem(TRUSTED_IMG_SENDERS_KEY, JSON.stringify([...set]));
  } catch {
    /* storage full/blocked — showing images this once still works */
  }
}

const PURIFY_CONFIG = {
  WHOLE_DOCUMENT: true, // keep <head><style> that real emails rely on
  FORBID_TAGS: [
    'script',
    'iframe',
    'frame',
    'object',
    'embed',
    'form',
    'input',
    'textarea',
    'select',
    'button',
    'base',
    'link',
    'meta',
    'audio',
    'video',
  ],
  FORBID_ATTR: ['srcset', 'ping', 'formaction'],
};

/** Selectors for well-known quoted-reply containers (Gmail/Outlook/Yahoo/Apple). */
const QUOTE_SELECTORS = [
  '.gmail_quote',
  '.gmail_quote_container',
  '.gmail_extra',
  '.yahoo_quoted',
  '#divRplyFwdMsg',
  '#OutlookMessageHeader',
  '.OutlookMessageHeader',
  '.moz-cite-prefix',
  'blockquote[type="cite"]',
].join(',');

/** Neutralize remote CSS fetches: url(http…) → none (backgrounds are trackers too). */
function stripRemoteCssUrls(css: string): { css: string; blocked: number } {
  let blocked = 0;
  const out = css.replace(/url\(\s*(?:'|")?\s*(?:https?:)?\/\/[^)]*\)/gi, () => {
    blocked += 1;
    return 'none';
  });
  return { css: out, blocked };
}

interface ProcessedEmail {
  mainHtml: string;
  quotedHtml: string | null;
  blockedImages: number;
}

/**
 * Sanitize + rewrite the raw html: block remote images (unless shown), resolve
 * cid: images to blob object-URLs, harden links, and split off quoted trailers.
 */
function processEmailHtml(
  raw: string,
  showRemote: boolean,
  cidUrls: Map<string, string>,
): ProcessedEmail {
  const clean = DOMPurify.sanitize(raw, PURIFY_CONFIG);
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  let blockedImages = 0;

  // Links: always new tab, never opener/referrer. (Sandbox allows popups.)
  doc.querySelectorAll('a').forEach((a) => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });

  // Images: resolve cid:, block remote unless shown.
  doc.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') ?? '';
    if (/^cid:/i.test(src)) {
      const cid = src.slice(4).replace(/^<|>$/g, '');
      const url = cidUrls.get(cid) ?? cidUrls.get(`<${cid}>`);
      if (url) img.setAttribute('src', url);
      else img.setAttribute('src', BLANK_IMG);
      return;
    }
    if (/^(https?:)?\/\//i.test(src)) {
      if (!showRemote) {
        blockedImages += 1;
        img.setAttribute('src', BLANK_IMG);
        img.setAttribute('data-eops-blocked', '1');
        if (!img.getAttribute('alt')) img.setAttribute('alt', 'blocked image');
      }
    }
    // data: and relative srcs pass through (relative resolves nowhere in srcDoc).
  });

  // Remote CSS fetches (style attrs + <style> tags) count as blocked images too.
  if (!showRemote) {
    doc.querySelectorAll('[style]').forEach((el) => {
      const style = el.getAttribute('style') ?? '';
      if (/url\(/i.test(style)) {
        const res = stripRemoteCssUrls(style);
        blockedImages += res.blocked;
        el.setAttribute('style', res.css);
      }
    });
    doc.querySelectorAll('style').forEach((el) => {
      const res = stripRemoteCssUrls(el.textContent ?? '');
      blockedImages += res.blocked;
      el.textContent = res.css;
    });
  }

  // Quoted trailers: known reply containers + trailing <blockquote> runs.
  const quoted: Element[] = [];
  doc.body.querySelectorAll(QUOTE_SELECTORS).forEach((el) => {
    // Only lift top-level-ish quotes; nested finds inside an already-lifted
    // container are covered by their ancestor.
    if (!quoted.some((q) => q.contains(el))) quoted.push(el);
  });
  // Trailing blockquotes at the end of the body (classic reply chains).
  let cursor = doc.body.lastElementChild;
  while (cursor) {
    const prev = cursor.previousElementSibling;
    const text = (cursor.textContent ?? '').trim();
    if (cursor.tagName === 'BLOCKQUOTE') {
      if (!quoted.includes(cursor)) quoted.push(cursor);
      cursor = prev;
      continue;
    }
    if ((cursor.tagName === 'BR' || cursor.tagName === 'HR') && text === '') {
      cursor = prev;
      continue;
    }
    break;
  }

  let quotedHtml: string | null = null;
  if (quoted.length > 0) {
    const container = doc.createElement('div');
    // Preserve document order.
    const ordered = quoted.sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
    for (const el of ordered) container.appendChild(el); // removes from body
    // Only actually collapse when meaningful content remains up top.
    const remaining = (doc.body.textContent ?? '').trim();
    const remainingImgs = doc.body.querySelectorAll('img').length;
    if (remaining.length > 0 || remainingImgs > 0) {
      quotedHtml = container.innerHTML;
    } else {
      doc.body.appendChild(container); // nothing else — keep the quote inline
    }
  }

  return { mainHtml: doc.documentElement.outerHTML, quotedHtml, blockedImages };
}

/** Read a `--token` var off the live document so the frame matches the theme. */
function tokenRgb(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v ? `rgb(${v})` : fallback;
}

export function HtmlEmailBody({
  html,
  senderAddress,
  attachments,
  resolveCidUrl,
  className,
}: {
  /** RAW UNSANITIZED html from the backend. */
  html: string;
  /** The sender (for the per-sender "always show images" memory). */
  senderAddress: string | null;
  /** The message's attachments — cid entries become inline images. */
  attachments: MailAttachment[];
  /** Resolves an attachment to an authenticated blob object-URL. */
  resolveCidUrl: (att: MailAttachment) => Promise<string>;
  className?: string;
}) {
  // Render client-side only (DOMPurify needs a real DOM; srcDoc measuring too).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // The frame must follow the APP theme, not the OS. Without this the iframe's
  // `color-scheme` resolved off `prefers-color-scheme`, so an OS-dark user who
  // set the app to light saw white-on-black email bodies over a light page.
  const { resolved: theme } = useTheme();

  const sender = senderAddress?.toLowerCase() ?? null;
  const [showRemote, setShowRemote] = useState(false);
  useEffect(() => {
    if (sender && loadTrustedSenders().has(sender)) setShowRemote(true);
  }, [sender]);

  const [showQuoted, setShowQuoted] = useState(false);

  // cid: → authenticated object URLs (fetched once per message; revoked on unmount).
  const [cidUrls, setCidUrls] = useState<Map<string, string>>(() => new Map());
  const cidAtts = useMemo(() => attachments.filter((a) => a.cid), [attachments]);
  useEffect(() => {
    if (cidAtts.length === 0) return;
    let alive = true;
    const urls: string[] = [];
    void (async () => {
      const next = new Map<string, string>();
      await Promise.all(
        cidAtts.map(async (att) => {
          try {
            const url = await resolveCidUrl(att);
            urls.push(url);
            next.set(att.cid!.replace(/^<|>$/g, ''), url);
          } catch {
            /* leave the placeholder */
          }
        }),
      );
      if (alive && next.size > 0) setCidUrls(next);
    })();
    return () => {
      alive = false;
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, [cidAtts, resolveCidUrl]);

  const processed = useMemo<ProcessedEmail | null>(() => {
    if (!mounted) return null;
    try {
      return processEmailHtml(html, showRemote, cidUrls);
    } catch {
      return null; // fall back to nothing — caller shows text_body/preview instead
    }
  }, [mounted, html, showRemote, cidUrls]);

  const srcDoc = useMemo(() => {
    if (!processed) return '';
    const text = tokenRgb('--text-primary', 'rgb(35 35 42)');
    const link = tokenRgb('--accent-text', 'rgb(124 92 255)');
    const muted = tokenRgb('--text-muted', 'rgb(120 120 132)');
    const baseCss = `
      :root { color-scheme: ${theme}; }
      html, body { height: auto !important; min-height: 0 !important; }
      body {
        margin: 0; padding: 2px 1px;
        font-family: Inter, ui-sans-serif, system-ui, sans-serif;
        font-size: 14px; line-height: 1.6; color: ${text};
        overflow-wrap: break-word; word-break: break-word; background: transparent;
      }
      img { max-width: 100%; height: auto; }
      img[data-eops-blocked] { border: 1px dashed ${muted}; border-radius: 4px; min-width: 24px; min-height: 16px; }
      a { color: ${link}; }
      blockquote { margin: 0.5em 0 0.5em 0.4em; padding-left: 0.8em; border-left: 2px solid ${muted}; color: ${muted}; }
      pre { white-space: pre-wrap; }
      table { max-width: 100%; }
    `;
    const body = processed.mainHtml + (showQuoted && processed.quotedHtml
      ? `<div data-eops-quoted>${processed.quotedHtml}</div>`
      : '');
    return `<!doctype html><style>${baseCss}</style>${body}`;
  }, [processed, showQuoted, theme]);

  // Auto-height: measure the same-origin srcDoc BODY content; track late shifts.
  // Only the body is measured — `documentElement.scrollHeight` is floored at the
  // iframe's own viewport height, so folding it in (via Math.max) trapped short
  // messages: the frame could grow for tall email but never shrink back to a
  // one-liner's true height, leaving a dead gap. `html, body { height: auto }`
  // (set !important in the srcDoc CSS) lets the body hug its content.
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(40);
  // Gates the entrance: the frame mounts at a placeholder 40px and only reveals
  // (fading + easing to real height) once the first content measurement lands,
  // so the reader never sees the raw 40px→full snap.
  const [measured, setMeasured] = useState(false);
  // Held so unmount can tear down the observer + pending re-measure timers.
  const observerRef = useRef<ResizeObserver | null>(null);
  const timersRef = useRef<number[]>([]);
  const measure = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc?.body) return;
    const h = doc.body.scrollHeight;
    if (h > 0) {
      setHeight(Math.min(Math.max(h + 4, 24), 20000));
      setMeasured(true);
    }
  }, []);
  const handleLoad = useCallback(() => {
    measure();
    const doc = iframeRef.current?.contentDocument;
    if (!doc?.body) return;
    try {
      observerRef.current?.disconnect();
      const ro = new ResizeObserver(() => measure());
      ro.observe(doc.body);
      observerRef.current = ro;
      doc.querySelectorAll('img').forEach((img) => img.addEventListener('load', measure));
    } catch {
      /* measurement best-effort; a fixed height still renders */
    }
    // A couple of delayed re-measures for slow-decoding images/fonts.
    timersRef.current.push(window.setTimeout(measure, 300));
    timersRef.current.push(window.setTimeout(measure, 1200));
  }, [measure]);
  // Tear down the observer + any pending timers when the message unmounts.
  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      for (const t of timersRef.current) window.clearTimeout(t);
      timersRef.current = [];
    };
  }, []);

  if (!mounted || !processed) return null;

  return (
    <div className={cn('min-w-0', className)}>
      {processed.blockedImages > 0 && !showRemote && (
        <div className="mb-2 flex w-full max-w-[680px] flex-wrap items-center gap-2 rounded-token border border-subtle bg-surface-overlay/60 px-2.5 py-1.5">
          <span className="text-[11px] text-tertiary">
            Remote images blocked ({processed.blockedImages})
          </span>
          <button
            type="button"
            onClick={() => setShowRemote(true)}
            className="rounded-token bg-accent/[0.08] px-1.5 py-0.5 text-[11px] font-medium text-accent transition-colors duration-fast ease-token hover:bg-accent/15"
          >
            Show images
          </button>
          {sender && (
            <button
              type="button"
              onClick={() => {
                rememberTrustedSender(sender);
                setShowRemote(true);
              }}
              className="rounded-token px-1.5 py-0.5 text-[11px] font-medium text-tertiary transition-colors duration-fast ease-token hover:bg-surface-overlay hover:text-primary"
              title={`Always show images from ${sender}`}
            >
              Always from this sender
            </button>
          )}
        </div>
      )}

      {/* Cap the readable body column at a comfortable ~680px measure while
          staying fluid below; the iframe stays w-full inside so the existing
          width→reflow→height measurement logic is unchanged. */}
      <div className="relative w-full max-w-[680px]">
        <iframe
          ref={iframeRef}
          title="Email content"
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          srcDoc={srcDoc}
          onLoad={handleLoad}
          className={cn(
            'w-full border-0 bg-transparent transition-[height,opacity] duration-token ease-token',
            !measured && 'opacity-0',
          )}
          style={{ height: `${height}px`, colorScheme: 'auto' }}
        />
        {!measured && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 animate-pulse rounded-token bg-surface-overlay/40"
          />
        )}
      </div>

      {processed.quotedHtml && (
        <button
          type="button"
          onClick={() => setShowQuoted((v) => !v)}
          aria-expanded={showQuoted}
          title={showQuoted ? 'Hide quoted text' : 'Show quoted text'}
          className="mt-1 inline-flex items-center gap-1 rounded-token px-1.5 py-0.5 text-[12px] text-tertiary transition-colors duration-token ease-token hover:text-secondary"
        >
          <svg
            viewBox="0 0 12 12"
            aria-hidden="true"
            className={cn(
              'h-3 w-3 transition-transform duration-token ease-token',
              showQuoted && 'rotate-180',
            )}
          >
            <path
              d="M3 4.5 6 7.5 9 4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {showQuoted ? 'Hide quoted text' : 'Show quoted text'}
        </button>
      )}
    </div>
  );
}

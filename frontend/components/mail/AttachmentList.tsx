'use client';

/**
 * Attachment UI shared by the viewer and the composers.
 *
 *  - `MessageAttachments`: chips on a received/sent message; click downloads
 *    through the authenticated blobs endpoint (object URL — an <a href> can't
 *    carry the bearer token).
 *  - `useAttachmentUploads` + `ComposerAttachments`: the composer side — file
 *    picker/drag-drop feeds `addFiles`, each file uploads to the attachments
 *    endpoint with a progress bar, and `refs()` yields the blob refs to include
 *    in the compose body. Pre-uploaded blobs (forward carrying the original's
 *    attachments) seed in as already-done chips.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/components/ui';
import { Tooltip } from '@/components/Tooltip';
import {
  fetchMailBlob,
  isMissingEndpoint,
  uploadMailAttachment,
  type ComposeAttachmentRef,
  type MailAttachment,
  type UploadedBlob,
} from '@/lib/mailApi';

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function PaperclipIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M21 12.5l-8.5 8.5a5.66 5.66 0 01-8-8l9-9a3.77 3.77 0 015.3 5.3l-9 9a1.89 1.89 0 01-2.7-2.7l8.3-8.3"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── Type glyphs ──────────────────────────────────────────────────────────────
// Map a MIME type / filename extension to a labelled badge so a PDF, sheet, doc,
// archive, etc. read apart at a glance. Falls back to the generic paperclip.

function extOf(name?: string | null): string {
  const m = /\.([a-z0-9]+)$/i.exec(name ?? '');
  return m ? m[1].toLowerCase() : '';
}

export function isImageAttachment(type?: string | null, name?: string | null): boolean {
  if (type && type.toLowerCase().startsWith('image/')) return true;
  return /^(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif|tiff?)$/.test(extOf(name));
}

interface AttachmentKind {
  /** 2–3 char badge, or null to draw the generic paperclip. */
  label: string | null;
  /** Tailwind bg+text tint for the badge. */
  badgeClass: string;
}

function attachmentKind(type?: string | null, name?: string | null): AttachmentKind {
  const t = (type ?? '').toLowerCase();
  const ext = extOf(name);
  const neutral = 'bg-surface-overlay text-tertiary';
  const is = (re: RegExp, exts: string[]) => re.test(t) || exts.includes(ext);

  if (isImageAttachment(type, name)) return { label: 'IMG', badgeClass: 'bg-info-subtle text-info' };
  if (t === 'application/pdf' || ext === 'pdf')
    return { label: 'PDF', badgeClass: 'bg-danger-subtle text-danger' };
  if (is(/word|opendocument\.text/, ['doc', 'docx', 'odt', 'rtf']))
    return { label: 'DOC', badgeClass: 'bg-info-subtle text-info' };
  if (is(/sheet|excel|csv/, ['xls', 'xlsx', 'ods', 'csv', 'tsv']))
    return { label: 'XLS', badgeClass: 'bg-success-subtle text-success' };
  if (is(/presentation|powerpoint/, ['ppt', 'pptx', 'odp', 'key']))
    return { label: 'PPT', badgeClass: 'bg-warning-subtle text-warning' };
  if (is(/zip|compressed|tar|gzip|x-7z|x-rar/, ['zip', 'rar', '7z', 'gz', 'tar', 'tgz', 'bz2', 'xz']))
    return { label: 'ZIP', badgeClass: neutral };
  if (t.startsWith('audio/') || ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg'].includes(ext))
    return { label: 'AUD', badgeClass: neutral };
  if (t.startsWith('video/') || ['mp4', 'mov', 'mkv', 'webm', 'avi'].includes(ext))
    return { label: 'VID', badgeClass: neutral };
  if (t.startsWith('text/') || ['txt', 'md', 'log', 'json', 'xml', 'yml', 'yaml'].includes(ext))
    return { label: 'TXT', badgeClass: neutral };
  return { label: null, badgeClass: neutral };
}

/**
 * The leading square: image thumbnail when we have one, else a type badge.
 * Exported for the agent-inbox review panel's read-only staged-attachment
 * chips — the prop is name/type meta only, so a not-yet-sent attachment
 * (no blob id) renders with the same visual language as a received one.
 */
export function AttachmentGlyph({
  att,
  thumbUrl,
}: {
  att: { name: string | null; type: string | null };
  thumbUrl?: string;
}) {
  const [imgOk, setImgOk] = useState(true);
  if (thumbUrl && imgOk) {
    return (
      <img
        src={thumbUrl}
        alt=""
        onError={() => setImgOk(false)}
        className="h-10 w-10 shrink-0 rounded-token border border-subtle object-cover"
      />
    );
  }
  const kind = attachmentKind(att.type, att.name);
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex h-10 w-10 shrink-0 items-center justify-center rounded-token',
        kind.badgeClass,
      )}
    >
      {kind.label ? (
        <span className="font-mono text-[10px] font-semibold tracking-tight">{kind.label}</span>
      ) : (
        <PaperclipIcon className="h-4 w-4" />
      )}
    </span>
  );
}

// ── Viewer side ──────────────────────────────────────────────────────────────

export function MessageAttachments({
  attachments,
  workspaceId,
  mailboxId,
}: {
  attachments: MailAttachment[];
  workspaceId: string;
  mailboxId: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Inline (cid) images already render in the body; list the rest for download.
  const files = useMemo(() => attachments.filter((a) => !a.cid), [attachments]);
  const imageFiles = useMemo(
    () => files.filter((a) => isImageAttachment(a.type, a.name)),
    [files],
  );

  // Image thumbnails via the same authenticated blob→object-URL path as cid
  // inline images (fetched once, revoked on unmount). Skip when there are too
  // many to avoid stampeding the blobs endpoint — those degrade to the glyph.
  const THUMB_LIMIT = 24;
  const [thumbs, setThumbs] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    if (imageFiles.length === 0 || imageFiles.length > THUMB_LIMIT) return;
    let alive = true;
    const urls: string[] = [];
    void (async () => {
      const next = new Map<string, string>();
      await Promise.all(
        imageFiles.map(async (att) => {
          try {
            const blob = await fetchMailBlob(workspaceId, mailboxId, att.blob_id, att.name, att.type);
            const url = URL.createObjectURL(blob);
            urls.push(url);
            next.set(att.blob_id, url);
          } catch {
            /* leave it to fall back to the image glyph */
          }
        }),
      );
      if (alive && next.size > 0) setThumbs(next);
    })();
    return () => {
      alive = false;
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, [imageFiles, workspaceId, mailboxId]);

  if (files.length === 0) return null;

  async function download(att: MailAttachment) {
    if (busy) return;
    setBusy(att.blob_id);
    setError(null);
    try {
      const blob = await fetchMailBlob(workspaceId, mailboxId, att.blob_id, att.name, att.type);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = att.name ?? 'attachment';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (err) {
      setError(
        isMissingEndpoint(err)
          ? 'Downloads are not available yet on this server.'
          : err instanceof Error
            ? err.message
            : 'Could not download the attachment.',
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-3 border-t border-subtle pt-2.5">
      <div className="flex flex-wrap gap-1.5">
        {files.map((att) => {
          const downloading = busy === att.blob_id;
          return (
            <button
              key={att.blob_id}
              type="button"
              disabled={busy !== null}
              onClick={() => void download(att)}
              aria-label={`Download ${att.name ?? 'attachment'}`}
              title={`Download ${att.name ?? 'attachment'}`}
              className={cn(
                'group inline-flex max-w-[14rem] items-center gap-2 rounded-token border border-subtle bg-surface-overlay/60 p-1.5 pr-2.5',
                'text-left transition-colors duration-fast ease-token',
                'hover:bg-surface-overlay disabled:opacity-50',
              )}
            >
              <AttachmentGlyph att={att} thumbUrl={thumbs.get(att.blob_id)} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-xs text-secondary group-hover:text-primary">
                  {att.name ?? 'attachment'}
                </span>
                <span className="flex items-center gap-1 text-[10px] leading-4 text-muted">
                  {downloading ? (
                    <span className="text-tertiary">downloading…</span>
                  ) : (
                    <>
                      {att.size != null && (
                        <span className="shrink-0 font-mono">{formatBytes(att.size)}</span>
                      )}
                      <span className="inline-flex items-center gap-0.5 text-tertiary opacity-0 transition-opacity duration-fast ease-token group-hover:opacity-100">
                        <DownloadIcon className="h-3 w-3" />
                        Download
                      </span>
                    </>
                  )}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {error && <p className="mt-1 text-[11px] text-danger">{error}</p>}
    </div>
  );
}

// ── Composer side ────────────────────────────────────────────────────────────

export interface PendingAttachment {
  key: string;
  name: string;
  size: number | null;
  type: string;
  status: 'uploading' | 'done' | 'error';
  /** 0..1 while uploading. */
  progress: number;
  blob_id?: string;
  error?: string;
}

let nextKey = 0;

/** Composer upload manager: picker/drop → progress chips → blob refs. */
export function useAttachmentUploads(workspaceId: string | null, mailboxId: string | null) {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  // Whether the attachments endpoint exists (404/501 hides the affordance).
  const [supported, setSupported] = useState(true);

  const patch = useCallback((key: string, fields: Partial<PendingAttachment>) => {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...fields } : it)));
  }, []);

  const addFiles = useCallback(
    (files: Iterable<File>) => {
      if (!workspaceId || !mailboxId) return;
      for (const file of files) {
        const key = `att-${++nextKey}`;
        setItems((prev) => [
          ...prev,
          {
            key,
            name: file.name,
            size: file.size,
            type: file.type || 'application/octet-stream',
            status: 'uploading',
            progress: 0,
          },
        ]);
        void uploadMailAttachment(workspaceId, mailboxId, file, (f) =>
          patch(key, { progress: f }),
        )
          .then((blob: UploadedBlob) =>
            patch(key, { status: 'done', progress: 1, blob_id: blob.blob_id }),
          )
          .catch((err: unknown) => {
            if (isMissingEndpoint(err)) {
              // Endpoint not deployed — drop the chip and hide the affordance.
              setSupported(false);
              setItems((prev) => prev.filter((it) => it.key !== key));
              return;
            }
            patch(key, {
              status: 'error',
              error: err instanceof Error ? err.message : 'Upload failed.',
            });
          });
      }
    },
    [workspaceId, mailboxId, patch],
  );

  const remove = useCallback((key: string) => {
    setItems((prev) => prev.filter((it) => it.key !== key));
  }, []);

  /** Seed with already-uploaded blobs (forwarding the original's attachments). */
  const reset = useCallback((prefill?: UploadedBlob[]) => {
    setItems(
      (prefill ?? []).map((b) => ({
        key: `att-${++nextKey}`,
        name: b.name,
        size: b.size ?? null,
        type: b.type,
        status: 'done' as const,
        progress: 1,
        blob_id: b.blob_id,
      })),
    );
  }, []);

  const uploading = items.some((it) => it.status === 'uploading');
  const refs = useCallback(
    (): ComposeAttachmentRef[] =>
      items
        .filter((it) => it.status === 'done' && it.blob_id)
        .map((it) => ({ blob_id: it.blob_id!, name: it.name, type: it.type })),
    [items],
  );

  return { items, addFiles, remove, reset, uploading, refs, supported };
}

export function ComposerAttachments({
  items,
  onRemove,
  disabled,
}: {
  items: PendingAttachment[];
  onRemove: (key: string) => void;
  disabled?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((it) => (
        <span
          key={it.key}
          className={cn(
            'relative inline-flex max-w-full items-center gap-1.5 overflow-hidden rounded-token border px-2 py-1 text-xs',
            it.status === 'error'
              ? 'border-danger/40 bg-danger-subtle text-danger'
              : 'border-subtle bg-surface-overlay/60 text-secondary',
          )}
          title={it.status === 'error' ? it.error : it.name}
        >
          {it.status === 'uploading' && (
            <span
              aria-hidden
              className="absolute inset-x-0 bottom-0 h-0.5 bg-accent transition-all duration-fast ease-token"
              style={{ width: `${Math.round(it.progress * 100)}%` }}
            />
          )}
          <PaperclipIcon className="h-3.5 w-3.5 shrink-0 text-tertiary" />
          <span className="min-w-0 truncate">{it.name}</span>
          <span className="shrink-0 font-mono text-[10px] text-muted">
            {it.status === 'uploading'
              ? `${Math.round(it.progress * 100)}%`
              : it.status === 'error'
                ? 'failed'
                : formatBytes(it.size)}
          </span>
          <button
            type="button"
            aria-label={`Remove ${it.name}`}
            disabled={disabled}
            onClick={() => onRemove(it.key)}
            className="shrink-0 rounded-full p-0.5 text-tertiary transition-colors duration-fast ease-token hover:bg-surface-overlay hover:text-primary disabled:opacity-50"
          >
            <svg viewBox="0 0 24 24" fill="none" className="h-3 w-3" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
            </svg>
          </button>
        </span>
      ))}
    </div>
  );
}

/** A hidden file input + "Attach" button, wired to `addFiles`. */
export function AttachButton({
  onFiles,
  disabled,
  className,
}: {
  onFiles: (files: FileList) => void;
  disabled?: boolean;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) onFiles(e.target.files);
          e.target.value = ''; // allow re-picking the same file
        }}
      />
      <Tooltip content="Attach files — or drop them anywhere on the message">
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-token px-2 py-1 text-xs font-medium text-tertiary',
            'transition-colors duration-fast ease-token hover:bg-surface-overlay/60 hover:text-primary',
            'disabled:pointer-events-none disabled:opacity-50',
            className,
          )}
        >
          <PaperclipIcon className="h-3.5 w-3.5" />
          Attach
        </button>
      </Tooltip>
    </>
  );
}

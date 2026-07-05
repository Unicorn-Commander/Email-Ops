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

import { useCallback, useRef, useState } from 'react';
import { cn } from '@/components/ui';
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
  const files = attachments.filter((a) => !a.cid);
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
        {files.map((att) => (
          <button
            key={att.blob_id}
            type="button"
            disabled={busy !== null}
            onClick={() => void download(att)}
            title={`Download ${att.name ?? 'attachment'}`}
            className={cn(
              'inline-flex max-w-full items-center gap-1.5 rounded-token border border-subtle bg-surface-overlay/60 px-2 py-1',
              'text-xs text-secondary transition-colors duration-fast ease-token',
              'hover:bg-surface-overlay hover:text-primary disabled:opacity-60',
            )}
          >
            <PaperclipIcon className="h-3.5 w-3.5 shrink-0 text-tertiary" />
            <span className="min-w-0 truncate">{att.name ?? 'attachment'}</span>
            {att.size != null && (
              <span className="shrink-0 font-mono text-[10px] text-muted">
                {formatBytes(att.size)}
              </span>
            )}
            {busy === att.blob_id && (
              <span className="shrink-0 text-[10px] text-tertiary">downloading…</span>
            )}
          </button>
        ))}
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
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-token px-2 py-1 text-xs font-medium text-tertiary',
          'transition-colors duration-fast ease-token hover:bg-surface-overlay/60 hover:text-primary',
          'disabled:pointer-events-none disabled:opacity-40',
          className,
        )}
        title="Attach files"
      >
        <PaperclipIcon className="h-3.5 w-3.5" />
        Attach
      </button>
    </>
  );
}

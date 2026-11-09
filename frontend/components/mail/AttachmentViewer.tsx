'use client';

import { useEffect, useState } from 'react';
import { Button, Dialog } from '@/components/ui';

export interface ViewerAttachment {
  name: string | null;
  type: string | null;
  size: number | null;
  load: () => Promise<Blob>;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TEXT_TYPES = new Set(['text/plain', 'text/csv']);
const TEXT_LIMIT = 1024 * 1024;

export function AttachmentViewer({ attachment, onClose }: {
  attachment: ViewerAttachment | null;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!attachment) return;
    let active = true;
    let objectUrl: string | null = null;
    setUrl(null);
    setText(null);
    setTruncated(false);
    setError(null);
    setLoading(true);
    void attachment.load().then(async (blob) => {
      if (!active) return;
      // Use the declared type only for the fixed preview allowlist.
      const type = attachment.type?.toLowerCase().trim() ?? '';
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
      if (TEXT_TYPES.has(type)) {
        setTruncated(blob.size > TEXT_LIMIT);
        const content = await blob.slice(0, TEXT_LIMIT).text();
        if (active) setText(content);
      }
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Could not open attachment.');
    }).finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment]);

  const name = attachment?.name ?? 'attachment';
  const type = attachment?.type?.toLowerCase().trim() ?? '';
  function download() {
    if (!url) return;
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  return (
    <Dialog open={!!attachment} onOpenChange={(open) => { if (!open) onClose(); }}
      title={name} description={`${attachment?.type ?? 'Unknown type'}${attachment?.size != null ? ` · ${attachment.size.toLocaleString()} bytes` : ''}`}
      className="max-w-4xl"
      footer={<Button onClick={download} disabled={!url}>Download</Button>}
    >
      {loading && <p>Loading attachment…</p>}
      {error && <p role="alert" className="text-danger">{error}</p>}
      {url && IMAGE_TYPES.has(type) && <img src={url} alt={name} className="max-h-[65vh] max-w-full object-contain" />}
      {url && type === 'application/pdf' && <iframe src={url} title={name} sandbox="" className="h-[65vh] w-full" />}
      {url && TEXT_TYPES.has(type) && text !== null && <>
        <pre className="max-h-[65vh] overflow-auto whitespace-pre-wrap break-words rounded-token bg-surface-base p-3 text-xs">{text}</pre>
        {truncated && <p className="mt-2 text-xs text-tertiary">Preview truncated at 1 MB.</p>}
      </>}
      {url && !IMAGE_TYPES.has(type) && type !== 'application/pdf' && !TEXT_TYPES.has(type) &&
        <p>Preview unavailable for this file type. Download it to open it.</p>}
    </Dialog>
  );
}

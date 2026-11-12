import type { AgentInboxNoticePayload } from '@/lib/api';
import type { MessageView } from '@/lib/mailApi';

const NOTICE_BODY_LINES = 40;

function htmlAsText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .trim();
}

export function firstNoticeBodyLines(message: MessageView | null): string | null {
  if (!message) return null;
  const body = message.text_body ?? message.preview ?? (message.html_body ? htmlAsText(message.html_body) : null);
  if (!body) return null;
  return body.split(/\r?\n/).slice(0, NOTICE_BODY_LINES).join('\n');
}

export function NoticeMessagePreview({
  notice,
  message,
  loading,
}: {
  notice: AgentInboxNoticePayload | null;
  message: MessageView | null;
  loading: boolean;
}) {
  if (!notice) return <p className="text-xs text-muted">This notice has no linked message</p>;

  const sender = message?.from?.address ?? notice.from;
  const subject = message?.subject || notice.subject || '(no subject)';
  const body = firstNoticeBodyLines(message);

  return (
    <section className="rounded-token border border-subtle bg-surface-base/50 p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-tertiary">
        Flagged message
      </p>
      <div className="mt-2 space-y-1 text-xs text-secondary">
        <p>
          <span className="font-medium text-tertiary">From:</span> {sender}
        </p>
        <p>
          <span className="font-medium text-tertiary">Subject:</span> {subject}
        </p>
        <p>
          <span className="font-medium text-tertiary">Received:</span> {notice.receivedAt}
        </p>
      </div>
      {loading ? (
        <p className="mt-2 text-xs text-muted">Loading linked message…</p>
      ) : body ? (
        <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-secondary">{body}</p>
      ) : (
        <p className="mt-2 text-xs italic text-muted">No message body captured.</p>
      )}
    </section>
  );
}

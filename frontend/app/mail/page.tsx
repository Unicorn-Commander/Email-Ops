'use client';

/**
 * Mail — the "retire Outlook" surface: read your inboxes + compose.
 *
 * A polished 3-pane mail client (think Superhuman/Linear restraint):
 *   LEFT   — mailbox picker (the workspace's mailboxes; defaults to the first).
 *   MIDDLE — the selected mailbox's thread list.
 *   RIGHT  — the open thread's messages + an inline Reply composer.
 * A top-level Compose button opens a new-message dialog.
 *
 * The mail engine is often DORMANT, which is expected and handled honestly:
 * thread lists come back empty (a calm empty state, not an error) and a compose
 * is recorded with `status: 'failed'` (the composer reports "Recorded — will
 * send once the engine is live"). Loading shows skeletons; real errors show
 * inline with a retry; a caller with no workspace gets an explicit empty state.
 *
 * Responsive: on mobile the three panes collapse to a single column — the thread
 * list drills into the open thread, with a Back control to return.
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Skeleton,
  SkeletonText,
  cn,
  type BadgeVariant,
} from '@/components/ui';
import { useActiveSpace } from '@/components/ActiveSpaceProvider';
import {
  formatWhen,
  participantLabel,
  useMailClient,
  type Load,
  type TriageOutcome,
} from '@/components/mail/useMailClient';
import { ReplyComposer } from '@/components/mail/ReplyComposer';
import { ComposeDialog } from '@/components/mail/ComposeDialog';
import { SendersDialog } from '@/components/mail/SendersDialog';
import type {
  MailboxPick,
  MailboxProvider,
  MailFolder,
  MessageView,
  ThreadView,
} from '@/lib/mailApi';

/** The folder tabs, in display order. */
const FOLDERS: { id: MailFolder; label: string }[] = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'archive', label: 'Archive' },
  { id: 'spam', label: 'Spam' },
  { id: 'trash', label: 'Trash' },
  { id: 'sent', label: 'Sent' },
  { id: 'drafts', label: 'Drafts' },
];

export default function MailPage() {
  const mail = useMailClient();
  const { activeSpace } = useActiveSpace();
  const [composeOpen, setComposeOpen] = useState(false);
  const [sendersOpen, setSendersOpen] = useState(false);

  const threadOpen = mail.selectedThreadId !== null;

  // Scope the mailbox picker to the active Space (purely client-side). "All" — a
  // null activeSpace — is unfiltered.
  const visibleMailboxes = useMemo(() => {
    if (!activeSpace) return mail.mailboxes;
    const allowed = new Set(activeSpace.mailbox_ids);
    return mail.mailboxes.filter((m) => allowed.has(m.id));
  }, [mail.mailboxes, activeSpace]);

  // Is the currently-open mailbox still visible under the active Space?
  const selectedVisible = visibleMailboxes.some((m) => m.id === mail.selectedMailbox?.id);

  // If the open mailbox got filtered out, fall back to the first visible one so
  // the user is never stranded on a hidden mailbox (don't crash / blank).
  const { load: mailLoad, selectMailbox } = mail;
  useEffect(() => {
    if (mailLoad !== 'ready') return;
    if (!activeSpace) return; // All — no scoping
    if (visibleMailboxes.length === 0) return; // empty-space state handles this
    if (!selectedVisible) selectMailbox(visibleMailboxes[0].id);
  }, [mailLoad, activeSpace, visibleMailboxes, selectedVisible, selectMailbox]);

  return (
    <div className="space-y-6">
      <Hero
        mailbox={selectedVisible ? mail.selectedMailbox : null}
        mailboxCount={visibleMailboxes.length}
        ready={mail.load === 'ready'}
        canCompose={mail.load === 'ready' && !!mail.workspace && selectedVisible}
        onCompose={() => setComposeOpen(true)}
      />

      {!mail.workspace && mail.load === 'ready' ? (
        <NoWorkspace />
      ) : mail.load === 'error' ? (
        <ErrorState message={mail.error} />
      ) : mail.load === 'loading' ? (
        <ClientSkeleton />
      ) : mail.mailboxes.length === 0 ? (
        <NoMailboxes />
      ) : visibleMailboxes.length === 0 ? (
        <NoSpaceMailboxes spaceName={activeSpace?.name ?? null} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(200px,260px)_minmax(280px,360px)_1fr]">
          {/* LEFT — mailbox picker. Hidden on mobile once a thread is open. */}
          <section className={cn(threadOpen && 'max-lg:hidden')}>
            <MailboxList
              mailboxes={visibleMailboxes}
              selectedId={selectedVisible ? mail.selectedMailbox?.id ?? null : null}
              onSelect={mail.selectMailbox}
            />
          </section>

          {/* MIDDLE — thread list. Hidden on mobile once a thread is open. */}
          <section className={cn('min-w-0', threadOpen && 'max-lg:hidden')}>
            <ThreadList
              load={mail.threadsLoad}
              error={mail.threadsError}
              threads={mail.threads}
              selectedThreadId={mail.selectedThreadId}
              onSelect={mail.selectThread}
              onRetry={mail.refreshThreads}
              folder={mail.folder}
              onSelectFolder={mail.selectFolder}
              onManageSenders={() => setSendersOpen(true)}
            />
          </section>

          {/* RIGHT — the open thread. The only pane shown on mobile when open. */}
          <section className={cn('min-w-0', !threadOpen && 'max-lg:hidden')}>
            <ThreadPane
              mailbox={mail.selectedMailbox}
              thread={mail.threads.find((t) => t.id === mail.selectedThreadId) ?? null}
              threadId={mail.selectedThreadId}
              load={mail.messagesLoad}
              error={mail.messagesError}
              messages={mail.messages}
              folder={mail.folder}
              onBack={() => mail.selectThread(null)}
              onReply={mail.reply}
              onTriage={mail.triage}
            />
          </section>
        </div>
      )}

      <ComposeDialog
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        fromAddress={mail.selectedMailbox?.email_address ?? null}
        onCompose={mail.compose}
      />

      <SendersDialog
        open={sendersOpen}
        onClose={() => setSendersOpen(false)}
        workspaceId={mail.workspace?.workspace_id ?? null}
      />
    </div>
  );
}

// ── Hero ───────────────────────────────────────────────────────────────────

function Hero({
  mailbox,
  mailboxCount,
  ready,
  canCompose,
  onCompose,
}: {
  mailbox: MailboxPick | null;
  mailboxCount: number;
  ready: boolean;
  canCompose: boolean;
  onCompose: () => void;
}) {
  return (
    <header className="relative overflow-hidden rounded-[20px] border border-subtle bg-surface-raised shadow-token">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_140%_at_100%_0%,rgb(var(--accent-2)/0.20),transparent_55%),radial-gradient(95%_130%_at_0%_100%,rgb(var(--accent)/0.18),transparent_55%),radial-gradient(80%_90%_at_50%_120%,rgb(var(--info)/0.12),transparent_60%)]" />
      <div className="relative p-5 sm:p-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="info" dot>
                {ready
                  ? mailboxCount === 1
                    ? '1 mailbox'
                    : `${mailboxCount} mailboxes`
                  : 'your inboxes'}
              </Badge>
              <Badge variant="protected">retire Outlook</Badge>
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-[-0.02em] text-primary sm:text-5xl">
              Your mail.{' '}
              <span className="bg-gradient-to-br from-accent via-[rgb(var(--accent-2))] to-info bg-clip-text text-transparent">
                One calm place.
              </span>
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-tertiary sm:text-base">
              {mailbox ? (
                <>
                  Reading <span className="font-mono text-secondary">{mailbox.email_address}</span>.
                  Pick a mailbox, open a thread, and reply — or start a new message.
                </>
              ) : (
                'Read your inboxes and compose, all in one place.'
              )}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row lg:items-center">
            <Button onClick={onCompose} disabled={!canCompose}>
              Compose
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}

// ── LEFT: mailbox picker ─────────────────────────────────────────────────────

const OWNER_TONE: Record<string, BadgeVariant> = {
  HUMAN: 'accent',
  AGENT: 'info',
  SHARED: 'protected',
};

/** Subtle per-mailbox provider tag (the backend it reads/sends through). */
const PROVIDER_TAG: Record<MailboxProvider, { label: string; tone: BadgeVariant }> = {
  stalwart: { label: 'Sovereign', tone: 'protected' },
  gmail: { label: 'Gmail', tone: 'neutral' },
  microsoft: { label: 'Outlook', tone: 'neutral' },
};

function MailboxList({
  mailboxes,
  selectedId,
  onSelect,
}: {
  mailboxes: MailboxPick[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-subtle px-3 py-2.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-tertiary">
          Mailboxes
        </span>
        <Link
          href="/accounts"
          className="ml-auto shrink-0 rounded-token px-2 py-0.5 text-[11px] font-medium text-tertiary transition-colors duration-fast ease-token hover:bg-surface-overlay/60 hover:text-primary"
          title="Connect a Gmail or Microsoft 365 account"
        >
          Connect an account
        </Link>
      </div>
      <ul className="max-h-[70vh] overflow-y-auto p-1.5">
        {mailboxes.map((mb) => {
          const active = mb.id === selectedId;
          const tag = mb.provider ? PROVIDER_TAG[mb.provider] : null;
          return (
            <li key={mb.id}>
              <button
                type="button"
                onClick={() => onSelect(mb.id)}
                aria-current={active}
                className={cn(
                  'flex w-full flex-col items-start gap-1 rounded-token px-2.5 py-2 text-left transition-colors duration-fast ease-token',
                  active
                    ? 'bg-surface-overlay text-primary shadow-token'
                    : 'text-tertiary hover:bg-surface-overlay/60 hover:text-primary',
                )}
              >
                <span className="flex w-full items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
                    {mb.display_name?.trim() || mb.email_address}
                  </span>
                  <Badge variant={OWNER_TONE[mb.owner_kind] ?? 'neutral'}>
                    {mb.owner_kind.toLowerCase()}
                  </Badge>
                </span>
                <span className="flex w-full items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">
                    {mb.email_address}
                  </span>
                  {tag && (
                    <Badge variant={tag.tone} className="shrink-0">
                      {tag.label}
                    </Badge>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// ── MIDDLE: thread list ──────────────────────────────────────────────────────

function ThreadList({
  load,
  error,
  threads,
  selectedThreadId,
  onSelect,
  onRetry,
  folder,
  onSelectFolder,
  onManageSenders,
}: {
  load: Load;
  error: string | null;
  threads: ThreadView[];
  selectedThreadId: string | null;
  onSelect: (id: string) => void;
  onRetry: () => void;
  folder: MailFolder;
  onSelectFolder: (folder: MailFolder) => void;
  onManageSenders: () => void;
}) {
  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-subtle px-3 py-2.5">
        <FolderTabs folder={folder} onSelect={onSelectFolder} />
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto shrink-0"
          onClick={onManageSenders}
          title="Blocked & trusted senders"
        >
          Manage senders
        </Button>
      </div>

      {load === 'loading' ? (
        <div className="space-y-1 p-2">
          {[0, 1, 2, 3].map((i) => (
            <ThreadRowSkeleton key={i} />
          ))}
        </div>
      ) : load === 'error' ? (
        <div className="p-4">
          <p className="text-sm font-medium text-primary">Could not load this folder.</p>
          <p className="mt-1 text-xs text-danger">{error ?? 'Unknown error.'}</p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : threads.length === 0 ? (
        <EmptyThreads folder={folder} />
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {threads.map((t) => (
            <ThreadRow
              key={t.id}
              thread={t}
              active={t.id === selectedThreadId}
              onSelect={() => onSelect(t.id)}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

/** The folder segmented control — a compact, horizontally-scrollable pill row. */
function FolderTabs({
  folder,
  onSelect,
}: {
  folder: MailFolder;
  onSelect: (folder: MailFolder) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Folders"
      className="-mx-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {FOLDERS.map((f) => {
        const active = f.id === folder;
        return (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(f.id)}
            className={cn(
              'shrink-0 rounded-token px-2.5 py-1 text-xs font-medium transition-colors duration-fast ease-token',
              active
                ? 'bg-surface-overlay text-primary shadow-token'
                : 'text-tertiary hover:bg-surface-overlay/60 hover:text-primary',
            )}
          >
            {f.label}
          </button>
        );
      })}
    </div>
  );
}

function ThreadRow({
  thread,
  active,
  onSelect,
}: {
  thread: ThreadView;
  active: boolean;
  onSelect: () => void;
}) {
  const when = useMemo(() => formatWhen(thread.last_message_at), [thread.last_message_at]);
  const who = useMemo(() => {
    const names = thread.participants
      .map((p) => p.name?.trim() || p.address)
      .filter(Boolean);
    if (names.length === 0) return 'No participants';
    if (names.length <= 2) return names.join(', ');
    return `${names[0]}, ${names[1]} +${names.length - 2}`;
  }, [thread.participants]);

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active}
        className={cn(
          'flex w-full flex-col gap-1 rounded-token px-2.5 py-2 text-left transition-colors duration-fast ease-token',
          active
            ? 'bg-surface-overlay shadow-token'
            : 'hover:bg-surface-overlay/60',
        )}
      >
        <div className="flex items-center gap-2">
          {thread.unread && (
            <span aria-label="unread" className="h-2 w-2 shrink-0 rounded-full bg-accent" />
          )}
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-xs',
              thread.unread ? 'font-semibold text-primary' : 'text-secondary',
            )}
          >
            {who}
          </span>
          {when && <span className="shrink-0 font-mono text-[10px] text-muted">{when}</span>}
        </div>
        <span
          className={cn(
            'truncate text-sm',
            thread.unread ? 'font-medium text-primary' : 'text-secondary',
          )}
        >
          {thread.subject?.trim() || '(no subject)'}
        </span>
        <div className="flex items-center gap-2">
          {thread.last_snippet && (
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted">
              {thread.last_snippet}
            </span>
          )}
          {thread.message_count > 1 && (
            <span className="shrink-0 rounded-token bg-surface-base px-1.5 font-mono text-[10px] text-muted">
              {thread.message_count}
            </span>
          )}
        </div>
      </button>
    </li>
  );
}

function ThreadRowSkeleton() {
  return (
    <div className="space-y-2 rounded-token px-2.5 py-2">
      <Skeleton w="40%" h={11} />
      <Skeleton w="80%" h={14} />
      <Skeleton w="60%" h={11} />
    </div>
  );
}

const EMPTY_COPY: Record<MailFolder, { title: string; detail: string }> = {
  inbox: {
    title: 'Inbox zero',
    detail: 'Nothing in your inbox. New mail appears here once the engine is connected.',
  },
  archive: {
    title: 'Archive is empty',
    detail: 'Threads you archive land here, out of your inbox but kept.',
  },
  spam: {
    title: 'No spam — nice',
    detail: 'Mail you mark as spam shows up here, and its sender gets blocked.',
  },
  trash: {
    title: 'Trash is empty',
    detail: 'Threads you delete rest here until they’re cleared.',
  },
  sent: {
    title: 'Nothing sent yet',
    detail: 'Messages you send appear here once the mail engine is connected.',
  },
  drafts: {
    title: 'No drafts',
    detail: 'Messages you start but don’t send are saved here.',
  },
};

function EmptyThreads({ folder }: { folder: MailFolder }) {
  const copy = EMPTY_COPY[folder];
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-full bg-surface-overlay text-tertiary">
        <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
          <path
            d="M3 7l9 6 9-6M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1z"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <p className="text-sm font-medium text-primary">{copy.title}</p>
      <p className="max-w-xs text-xs leading-5 text-tertiary">{copy.detail}</p>
    </div>
  );
}

// ── RIGHT: the open thread + reply composer ──────────────────────────────────

function ThreadPane({
  mailbox,
  thread,
  threadId,
  load,
  error,
  messages,
  folder,
  onBack,
  onReply,
  onTriage,
}: {
  mailbox: MailboxPick | null;
  /** The thread row (for subject/participants); may be null if not in the list. */
  thread: ThreadView | null;
  threadId: string | null;
  load: Load;
  error: string | null;
  messages: MessageView[];
  folder: MailFolder;
  onBack: () => void;
  onReply: React.ComponentProps<typeof ReplyComposer>['onSend'];
  onTriage: (
    threadId: string,
    disposition: 'INBOX' | 'ARCHIVE' | 'TRASH' | 'SPAM',
    opts?: { blockSender?: boolean; trustSender?: boolean; senderAddress?: string },
  ) => Promise<TriageOutcome>;
}) {
  // Prefill the reply: the other party + "Re: <subject>".
  const replyDefaults = useMemo(
    () => deriveReplyDefaults(messages, thread, mailbox),
    [messages, thread, mailbox],
  );

  if (!threadId) {
    return <NoThreadSelected />;
  }

  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <div className="flex items-start gap-2 border-b border-subtle px-4 py-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          className="lg:hidden"
          aria-label="Back to threads"
        >
          ← Back
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-primary">
            {thread?.subject?.trim() || '(no subject)'}
          </p>
          {load === 'ready' && (
            <p className="mt-0.5 text-[11px] text-muted">
              {messages.length} {messages.length === 1 ? 'message' : 'messages'}
            </p>
          )}
        </div>
        <TriageActions
          threadId={threadId}
          folder={folder}
          otherParty={replyDefaults.to || null}
          onTriage={onTriage}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {load === 'loading' ? (
          <div className="space-y-3 p-4">
            <MessageSkeleton />
            <MessageSkeleton />
          </div>
        ) : load === 'error' ? (
          <div className="p-4">
            <p className="text-sm font-medium text-primary">Could not load this conversation.</p>
            <p className="mt-1 text-xs text-danger">{error ?? 'Unknown error.'}</p>
          </div>
        ) : messages.length === 0 ? (
          <div className="p-6 text-center">
            <p className="text-sm text-tertiary">
              No messages in this thread yet — they appear here once the mail engine is connected.
            </p>
          </div>
        ) : (
          <ul className="space-y-3 p-4">
            {messages.map((m) => (
              <MessageItem key={m.id} message={m} />
            ))}
          </ul>
        )}
      </div>

      {/* Reply composer — available whenever a thread is open. */}
      {load !== 'error' && (
        <ReplyComposer
          defaultTo={replyDefaults.to}
          defaultSubject={replyDefaults.subject}
          onSend={onReply}
        />
      )}
    </Card>
  );
}

/**
 * Triage buttons in the thread header. The set adapts to the current folder:
 * Inbox shows Archive / Spam / Trash; other folders add "Move to Inbox", and in
 * Spam that action becomes "Not spam" (which trusts the sender). Marking Spam
 * blocks the other party. All actions disable while a call is in flight, and a
 * failure surfaces a small inline note.
 */
function TriageActions({
  threadId,
  folder,
  otherParty,
  onTriage,
}: {
  threadId: string;
  folder: MailFolder;
  otherParty: string | null;
  onTriage: (
    threadId: string,
    disposition: 'INBOX' | 'ARCHIVE' | 'TRASH' | 'SPAM',
    opts?: { blockSender?: boolean; trustSender?: boolean; senderAddress?: string },
  ) => Promise<TriageOutcome>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(
    disposition: 'INBOX' | 'ARCHIVE' | 'TRASH' | 'SPAM',
    opts?: { blockSender?: boolean; trustSender?: boolean; senderAddress?: string },
  ) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await onTriage(threadId, disposition, opts);
    // On success the thread closes (it left this folder); only need to surface
    // an error, in which case the pane is still mounted to show it.
    if (!res.ok) {
      setError(res.error ?? 'Could not move this conversation.');
      setBusy(false);
    }
  }

  const inSpam = folder === 'spam';
  const showInbox = folder !== 'inbox';

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        {showInbox && (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run('INBOX', inSpam ? { trustSender: true, senderAddress: otherParty ?? undefined } : undefined)
            }
            title={inSpam ? 'Not spam — move to inbox and trust the sender' : 'Move to inbox'}
          >
            {inSpam ? 'Not spam' : 'Move to inbox'}
          </Button>
        )}
        {folder !== 'archive' && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void run('ARCHIVE')}
            title="Archive"
          >
            Archive
          </Button>
        )}
        {!inSpam && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void run('SPAM', { blockSender: true, senderAddress: otherParty ?? undefined })}
            title="Mark as spam and block the sender"
          >
            Spam
          </Button>
        )}
        {folder !== 'trash' && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void run('TRASH')}
            title="Move to trash"
          >
            Trash
          </Button>
        )}
      </div>
      {error && <p className="max-w-[14rem] text-right text-[11px] text-danger">{error}</p>}
    </div>
  );
}

const DIRECTION_META: Record<string, { label: string; tone: BadgeVariant }> = {
  sent: { label: 'sent', tone: 'info' },
  received: { label: 'received', tone: 'neutral' },
  draft: { label: 'draft', tone: 'warning' },
};

function MessageItem({ message }: { message: MessageView }) {
  const when = useMemo(() => formatWhen(message.sent_at), [message.sent_at]);
  const dir = DIRECTION_META[message.direction] ?? {
    label: message.direction || 'message',
    tone: 'neutral' as BadgeVariant,
  };
  const toLabel = useMemo(
    () => message.to.map((t) => participantLabel(t)).join(', '),
    [message.to],
  );

  return (
    <li className="rounded-token border border-subtle bg-surface-base/50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium text-primary">
          {participantLabel(message.from)}
        </span>
        <Badge variant={dir.tone}>{dir.label}</Badge>
        {when && <span className="ml-auto shrink-0 font-mono text-[10px] text-muted">{when}</span>}
      </div>
      {toLabel && (
        <p className="mt-0.5 truncate font-mono text-[11px] text-muted">to {toLabel}</p>
      )}
      {message.preview && (
        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-secondary">
          {message.preview}
        </p>
      )}
    </li>
  );
}

function MessageSkeleton() {
  return (
    <div className="rounded-token border border-subtle bg-surface-base/50 p-3">
      <div className="flex items-center gap-2">
        <Skeleton w="30%" h={14} />
        <Skeleton w={56} h={16} className="ml-auto" />
      </div>
      <div className="mt-3">
        <SkeletonText lines={2} />
      </div>
    </div>
  );
}

function NoThreadSelected() {
  return (
    <Card className="hidden h-full lg:flex">
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-10 text-center">
        <div className="grid h-12 w-12 place-items-center rounded-full bg-surface-overlay text-tertiary">
          <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
            <path
              d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <p className="text-sm font-medium text-primary">Select a conversation</p>
        <p className="max-w-xs text-xs leading-5 text-tertiary">
          Pick a thread from the list to read it and reply.
        </p>
      </div>
    </Card>
  );
}

// ── Top-level states ─────────────────────────────────────────────────────────

function ClientSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(200px,260px)_minmax(280px,360px)_1fr]">
      <Card padded className="space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} h={44} />
        ))}
      </Card>
      <Card padded className="space-y-2">
        {[0, 1, 2, 3].map((i) => (
          <ThreadRowSkeleton key={i} />
        ))}
      </Card>
      <Card padded className="hidden space-y-3 lg:block">
        <MessageSkeleton />
        <MessageSkeleton />
      </Card>
    </div>
  );
}

function ErrorState({ message }: { message: string | null }) {
  return (
    <Card padded className="border-danger/30 ring-1 ring-danger/15">
      <p className="text-sm font-medium text-primary">Could not load your mail.</p>
      <p className="mt-1 text-xs text-danger">{message ?? 'Unknown error.'}</p>
    </Card>
  );
}

function NoWorkspace() {
  return (
    <Card padded>
      <p className="text-sm font-medium text-primary">No workspace yet.</p>
      <p className="mt-1 text-sm text-tertiary">
        Your account isn’t a member of an Email-Ops workspace, so there are no mailboxes to show.
      </p>
    </Card>
  );
}

function NoMailboxes() {
  return (
    <Card padded className="overflow-hidden border-info/30 bg-info-subtle ring-1 ring-info/20">
      <div className="flex items-start gap-4">
        <div className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-gradient-to-br from-info/30 to-info/5 text-info ring-1 ring-info/30">
          <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7" aria-hidden="true">
            <path
              d="M3 7l9 6 9-6M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1z"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div>
          <p className="text-base font-semibold text-primary">No mailboxes yet.</p>
          <p className="mt-1 text-sm text-tertiary">
            Once a mailbox is provisioned for this workspace it shows up here, and you can read it
            and compose from it.
          </p>
        </div>
      </div>
    </Card>
  );
}

/** Shown when a real Space is active but scopes out every mailbox. */
function NoSpaceMailboxes({ spaceName }: { spaceName: string | null }) {
  return (
    <Card padded className="overflow-hidden border-info/30 bg-info-subtle ring-1 ring-info/20">
      <div className="flex items-start gap-4">
        <div className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-gradient-to-br from-info/30 to-info/5 text-info ring-1 ring-info/30">
          <svg viewBox="0 0 24 24" fill="none" className="h-7 w-7" aria-hidden="true">
            <path
              d="M3 7l9 6 9-6M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1z"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div>
          <p className="text-base font-semibold text-primary">
            No mailboxes in {spaceName ? <span className="font-mono">{spaceName}</span> : 'this space'}.
          </p>
          <p className="mt-1 text-sm text-tertiary">
            This space doesn’t include any mailboxes yet. Add some from “Manage spaces…” in the top
            bar, or switch back to “All”.
          </p>
        </div>
      </div>
    </Card>
  );
}

// ── Reply prefill ────────────────────────────────────────────────────────────

/**
 * Derive the reply prefill: address the conversation's *other* party (not our
 * own mailbox), and prefix the subject with "Re: " once. Prefers the latest
 * received message's sender; falls back to a thread participant.
 */
function deriveReplyDefaults(
  messages: MessageView[],
  thread: ThreadView | null,
  mailbox: MailboxPick | null,
): { to: string; subject: string } {
  const self = mailbox?.email_address?.toLowerCase() ?? '';

  // Prefer the most recent inbound message's sender as the reply target.
  let to = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const from = messages[i].from?.address;
    if (from && from.toLowerCase() !== self) {
      to = from;
      break;
    }
  }
  // Fall back to a thread participant that isn't us.
  if (!to && thread) {
    const other = thread.participants.find((p) => p.address && p.address.toLowerCase() !== self);
    to = other?.address ?? thread.participants[0]?.address ?? '';
  }

  const subject = deriveReSubject(thread?.subject ?? lastSubject(messages));
  return { to, subject };
}

function lastSubject(messages: MessageView[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].subject) return messages[i].subject;
  }
  return null;
}

function deriveReSubject(subject: string | null): string {
  const base = subject?.trim() ?? '';
  if (!base) return 'Re:';
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

'use client';

/**
 * Mail — the "retire Outlook" surface: read your inboxes + compose.
 *
 * A polished 3-pane mail client (think Superhuman/Linear restraint):
 *   LEFT   — mailbox picker ("All inboxes" pinned on top when the aggregate
 *            endpoint is live, then the workspace's mailboxes with unread badges).
 *   MIDDLE — the thread list: debounced search, selection checkboxes + bulk bar,
 *            offset-paged "Load more".
 *   RIGHT  — the open thread: collapsed conversation (last message expanded),
 *            sanitized HTML bodies, attachments, Reply / Reply-all / Forward,
 *            and an inline Reply composer.
 * A top-level Compose button opens a new-message dialog. A Gmail-style keyboard
 * layer (press ? for the reference) drives the whole thing.
 *
 * Every Wave-2 endpoint (aggregate, counts, read, bulk, blobs, attachments) is
 * feature-detected: a 404/501 hides that affordance gracefully — no crashes,
 * no error toasts.
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
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
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
import { useUiCommands } from '@/components/UiCommandProvider';
import {
  ALL_INBOXES,
  formatWhen,
  participantLabel,
  useMailClient,
  type Load,
  type TriageOutcome,
  type UseMailClient,
} from '@/components/mail/useMailClient';
import { ReplyComposer, type ReplyComposerHandle } from '@/components/mail/ReplyComposer';
import { ComposeDialog, type ComposeDialogPrefill } from '@/components/mail/ComposeDialog';
import { SendersDialog } from '@/components/mail/SendersDialog';
import { MessageItem } from '@/components/mail/MessageItem';
import { SearchBar } from '@/components/mail/SearchBar';
import { BulkBar } from '@/components/mail/BulkBar';
import { ShortcutsHelp } from '@/components/mail/ShortcutsHelp';
import { useMailShortcuts } from '@/components/mail/useMailShortcuts';
import type {
  BulkAction,
  MailboxPick,
  MailboxProvider,
  MailFolder,
  MessageView,
  ThreadView,
  UploadedBlob,
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

/** A composer prefill carried by an agent's `ui_compose` (Phase C) or Forward. */
interface ComposePrefill extends ComposeDialogPrefill {
  /** If set, sending threads the message into this conversation. */
  thread_id?: string;
}

/** A reply-composer seed (default derive, or Reply / Reply-all on a message). */
interface ReplySeed {
  to: string[];
  cc: string[];
  subject: string;
  /** RFC threading hint: the id of the message being replied to. */
  inReplyTo: string | null;
  /** Bumps to remount the composer when a new seed is picked. */
  nonce: number;
}

export default function MailPage() {
  const mail = useMailClient();
  const { activeSpace } = useActiveSpace();
  const { version, consumeLocal } = useUiCommands();
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeInitial, setComposeInitial] = useState<ComposePrefill | null>(null);
  const [sendersOpen, setSendersOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  // Selection (bulk actions) + keyboard cursor over the thread list.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [cursor, setCursor] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);
  const replyRef = useRef<ReplyComposerHandle>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  // Reply-composer seeding (Reply vs Reply-all vs the default derive).
  const [replySeed, setReplySeed] = useState<ReplySeed | null>(null);

  const threadOpen = mail.selectedThreadId !== null;

  // ── Phase C: apply agent-staged page-local commands (open_thread / compose) ──
  // The UiCommandBridge stages these then navigates here; we drain them on mount
  // and whenever a new command bumps `version`. The mail setters used below are
  // stable (useCallback in the hook); the current mailbox is read via a ref so
  // this effect stays purely version-driven and doesn't re-consume on every
  // unrelated mailbox change.
  const { selectMailbox, selectThread } = mail;
  const selectedMailboxIdRef = useRef<string | null>(null);
  selectedMailboxIdRef.current = mail.unified ? ALL_INBOXES : mail.selectedMailbox?.id ?? null;
  // Staged target when an open_thread also has to SWITCH mailbox first — the
  // hook's mailbox-change effect closes any open thread, so we defer opening the
  // thread until that switch settles (see the effect below).
  const pendingOpenRef = useRef<{ mailboxId: string; threadId: string } | null>(null);

  useEffect(() => {
    const openThread = consumeLocal('open_thread');
    if (openThread) {
      const { mailbox_id, thread_id } = openThread.payload;
      if (mailbox_id && mailbox_id !== selectedMailboxIdRef.current) {
        // Switch mailbox first, then open the thread once the list settles.
        pendingOpenRef.current = { mailboxId: mailbox_id, threadId: thread_id };
        selectMailbox(mailbox_id);
      } else {
        selectThread(thread_id, mailbox_id ?? undefined);
      }
    }

    const compose = consumeLocal('compose');
    if (compose) {
      setComposeInitial({ ...compose.payload });
      setComposeOpen(true);
    }
  }, [version, consumeLocal, selectMailbox, selectThread]);

  // Once a staged mailbox switch has settled (the hook closed the old thread and
  // the new list is ready), open the deferred thread.
  const { selectedMailbox, threadsLoad } = mail;
  useEffect(() => {
    const pending = pendingOpenRef.current;
    if (!pending) return;
    if (selectedMailbox?.id !== pending.mailboxId) return;
    if (threadsLoad !== 'ready') return;
    pendingOpenRef.current = null;
    selectThread(pending.threadId, pending.mailboxId);
  }, [selectedMailbox?.id, threadsLoad, selectThread]);

  // Scope the mailbox picker to the active Space (purely client-side). "All" — a
  // null activeSpace — is unfiltered.
  const visibleMailboxes = useMemo(() => {
    if (!activeSpace) return mail.mailboxes;
    const allowed = new Set(activeSpace.mailbox_ids);
    return mail.mailboxes.filter((m) => allowed.has(m.id));
  }, [mail.mailboxes, activeSpace]);

  // Is the currently-open mailbox still visible under the active Space?
  // (The unified "All inboxes" list is always considered visible.)
  const selectedVisible =
    mail.unified || visibleMailboxes.some((m) => m.id === mail.selectedMailbox?.id);

  // If the open mailbox got filtered out, fall back to the first visible one so
  // the user is never stranded on a hidden mailbox (don't crash / blank).
  const { load: mailLoad } = mail;
  useEffect(() => {
    if (mailLoad !== 'ready') return;
    if (!activeSpace) return; // All — no scoping
    if (visibleMailboxes.length === 0) return; // empty-space state handles this
    if (!selectedVisible) selectMailbox(visibleMailboxes[0].id);
  }, [mailLoad, activeSpace, visibleMailboxes, selectedVisible, selectMailbox]);

  // ── Selection + cursor housekeeping ────────────────────────────────────────
  const threads = mail.threads;

  // Prune selection to rows still in the list; clamp the cursor.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const inList = new Set(threads.map((t) => t.id));
      const next = new Set([...prev].filter((id) => inList.has(id)));
      return next.size === prev.size ? prev : next;
    });
    setCursor((c) => Math.min(c, threads.length - 1));
  }, [threads]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelected((prev) =>
      prev.size >= threads.length ? new Set() : new Set(threads.map((t) => t.id)),
    );
  }, [threads]);

  // ── Open-thread context (mailbox, row, reply seeding) ──────────────────────
  const openThreadRow = threads.find((t) => t.id === mail.selectedThreadId) ?? null;
  const threadMailbox =
    mail.mailboxes.find((m) => m.id === mail.selectedThreadMailboxId) ?? mail.selectedMailbox;
  const selfAddress = threadMailbox?.email_address ?? mail.composeMailbox?.email_address ?? '';

  const defaultReply = useMemo(
    () => deriveReplyDefaults(mail.messages, openThreadRow, threadMailbox),
    [mail.messages, openThreadRow, threadMailbox],
  );
  const activeSeed = replySeed ?? defaultReply;

  // A new open thread resets any Reply/Reply-all seeding back to the default.
  useEffect(() => {
    setReplySeed(null);
  }, [mail.selectedThreadId]);

  const focusReplySoon = useCallback(() => {
    window.setTimeout(() => replyRef.current?.focus(), 60);
  }, []);

  const seedReply = useCallback(
    (m: MessageView) => {
      setReplySeed((prev) => ({
        ...deriveReplyToMessage(m, selfAddress, openThreadRow),
        nonce: (prev?.nonce ?? 0) + 1,
      }));
      focusReplySoon();
    },
    [selfAddress, openThreadRow, focusReplySoon],
  );

  const seedReplyAll = useCallback(
    (m: MessageView) => {
      setReplySeed((prev) => ({
        ...deriveReplyAll(m, selfAddress, openThreadRow),
        nonce: (prev?.nonce ?? 0) + 1,
      }));
      focusReplySoon();
    },
    [selfAddress, openThreadRow, focusReplySoon],
  );

  const forwardMessage = useCallback((m: MessageView, thread: ThreadView | null) => {
    setComposeInitial(buildForwardPrefill(m, thread));
    setComposeOpen(true);
  }, []);

  // ── Bulk actions ───────────────────────────────────────────────────────────
  const runBulk = useCallback(
    async (action: BulkAction): Promise<{ ok: boolean; error?: string }> => {
      const ids = [...selected];
      if (ids.length === 0) return { ok: false };
      const res = await mail.bulk(ids, action);
      if (res.ok || res.unsupported) setSelected(new Set());
      return { ok: res.ok, error: res.unsupported ? undefined : res.error };
    },
    [selected, mail],
  );

  // ── Keyboard layer ─────────────────────────────────────────────────────────
  const lastMessage = mail.messages[mail.messages.length - 1] ?? null;
  const cursorThread = cursor >= 0 ? threads[cursor] ?? null : null;

  const moveCursor = useCallback(
    (delta: 1 | -1) => {
      if (threads.length === 0) return;
      setCursor((c) => {
        const next = c < 0 ? (delta > 0 ? 0 : threads.length - 1) : Math.min(threads.length - 1, Math.max(0, c + delta));
        const id = threads[next]?.id;
        if (id) rowRefs.current.get(id)?.scrollIntoView({ block: 'nearest' });
        return next;
      });
    },
    [threads],
  );

  const keyboardTargetId = mail.selectedThreadId ?? cursorThread?.id ?? null;

  const shortcutTriage = useCallback(
    (disposition: 'ARCHIVE' | 'TRASH') => {
      const bulkAction: BulkAction = disposition === 'ARCHIVE' ? 'archive' : 'trash';
      if (selected.size > 0 && mail.features.bulk) {
        void runBulk(bulkAction);
        return;
      }
      if (keyboardTargetId) void mail.triage(keyboardTargetId, disposition);
    },
    [selected, mail, runBulk, keyboardTargetId],
  );

  const shortcutMark = useCallback(
    (read: boolean) => {
      if (selected.size > 0) {
        if (mail.features.bulk) void runBulk(read ? 'read' : 'unread');
        else mail.markRead([...selected], read);
        return;
      }
      if (keyboardTargetId) mail.markRead([keyboardTargetId], read);
    },
    [selected, mail, runBulk, keyboardTargetId],
  );

  useMailShortcuts(
    {
      onMove: moveCursor,
      onOpen: () => {
        const t = cursorThread ?? threads[0];
        if (t) selectThread(t.id, t.mailbox_id);
      },
      onBack: () => selectThread(null),
      onArchive: () => shortcutTriage('ARCHIVE'),
      onTrash: () => shortcutTriage('TRASH'),
      onReply: () => {
        if (threadOpen) focusReplySoon();
      },
      onReplyAll: () => {
        if (threadOpen && lastMessage) seedReplyAll(lastMessage);
      },
      onForward: () => {
        if (threadOpen && lastMessage) forwardMessage(lastMessage, openThreadRow);
      },
      onFocusSearch: () => searchRef.current?.focus(),
      onToggleSelect: () => {
        if (cursorThread && mail.features.bulk) toggleSelect(cursorThread.id);
      },
      onMarkRead: () => shortcutMark(true),
      onMarkUnread: () => shortcutMark(false),
      onHelp: () => setHelpOpen(true),
    },
    !composeOpen && !sendersOpen && !helpOpen,
  );

  // Per-mailbox unread badges (Wave-2 counts endpoint; null = hidden).
  const unreadByMailbox = useMemo(() => {
    if (!mail.counts) return null;
    return new Map(mail.counts.map((c) => [c.mailbox_id, c.inbox_unread]));
  }, [mail.counts]);
  const totalUnread = useMemo(() => {
    if (!mail.counts) return null;
    const visible = activeSpace ? new Set(visibleMailboxes.map((m) => m.id)) : null;
    return mail.counts.reduce(
      (sum, c) => (visible && !visible.has(c.mailbox_id) ? sum : sum + c.inbox_unread),
      0,
    );
  }, [mail.counts, activeSpace, visibleMailboxes]);

  const showAllInboxes = mail.features.aggregate && visibleMailboxes.length > 1;

  return (
    <div className="space-y-6">
      <Hero
        mailbox={selectedVisible && !mail.unified ? mail.selectedMailbox : null}
        unified={mail.unified}
        mailboxCount={visibleMailboxes.length}
        ready={mail.load === 'ready'}
        canCompose={
          mail.load === 'ready' &&
          !!mail.workspace &&
          (mail.unified ? visibleMailboxes.length > 0 : selectedVisible)
        }
        onCompose={() => {
          setComposeInitial(null);
          setComposeOpen(true);
        }}
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
              selectedId={
                mail.unified ? ALL_INBOXES : selectedVisible ? mail.selectedMailbox?.id ?? null : null
              }
              onSelect={mail.selectMailbox}
              showAllInboxes={showAllInboxes}
              unreadByMailbox={unreadByMailbox}
              totalUnread={totalUnread}
            />
          </section>

          {/* MIDDLE — thread list. Hidden on mobile once a thread is open. */}
          <section className={cn('min-w-0', threadOpen && 'max-lg:hidden')}>
            <ThreadList
              load={mail.threadsLoad}
              error={mail.threadsError}
              threads={threads}
              selectedThreadId={mail.selectedThreadId}
              onSelect={(t) => selectThread(t.id, t.mailbox_id)}
              onRetry={mail.refreshThreads}
              folder={mail.folder}
              onSelectFolder={mail.selectFolder}
              onManageSenders={() => setSendersOpen(true)}
              searchRef={searchRef}
              query={mail.query}
              onQuery={mail.setQuery}
              unified={mail.unified}
              selectable={mail.features.bulk}
              selected={selected}
              onToggleSelect={toggleSelect}
              onToggleSelectAll={toggleSelectAll}
              cursorThreadId={cursorThread?.id ?? null}
              hasMore={mail.hasMore}
              loadingMore={mail.loadingMore}
              onLoadMore={mail.loadMore}
              rowRefs={rowRefs}
            />
          </section>

          {/* RIGHT — the open thread. The only pane shown on mobile when open. */}
          <section className={cn('min-w-0', !threadOpen && 'max-lg:hidden')}>
            <ThreadPane
              workspaceId={mail.workspace?.workspace_id ?? null}
              mailbox={threadMailbox}
              thread={openThreadRow}
              threadId={mail.selectedThreadId}
              load={mail.messagesLoad}
              error={mail.messagesError}
              messages={mail.messages}
              folder={mail.folder}
              onBack={() => selectThread(null)}
              onReply={mail.reply}
              onTriage={mail.triage}
              replySeed={activeSeed}
              replyRef={replyRef}
              onSeedReply={seedReply}
              onSeedReplyAll={seedReplyAll}
              onForward={(m) => forwardMessage(m, openThreadRow)}
            />
          </section>
        </div>
      )}

      {/* Floating bulk bar (Wave-2 bulk endpoint; hidden when not deployed). */}
      {mail.features.bulk && (
        <BulkBar
          count={selected.size}
          folder={mail.folder}
          onAction={runBulk}
          onClear={() => setSelected(new Set())}
        />
      )}

      <ComposeDialog
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        fromAddress={mail.composeMailbox?.email_address ?? null}
        workspaceId={mail.workspace?.workspace_id ?? null}
        mailboxId={mail.composeMailbox?.id ?? null}
        // Thread the send when the prefill carried a thread_id; otherwise a plain
        // new message. Either way it PREFILLS — the user still clicks Send.
        onCompose={(b) =>
          mail.compose(
            composeInitial?.thread_id
              ? { ...b, in_reply_to_thread_id: composeInitial.thread_id }
              : b,
            mail.composeMailbox?.id,
          )
        }
        initial={composeInitial}
      />

      <SendersDialog
        open={sendersOpen}
        onClose={() => setSendersOpen(false)}
        workspaceId={mail.workspace?.workspace_id ?? null}
      />

      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

// ── Hero ───────────────────────────────────────────────────────────────────

function Hero({
  mailbox,
  unified,
  mailboxCount,
  ready,
  canCompose,
  onCompose,
}: {
  mailbox: MailboxPick | null;
  unified: boolean;
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
              {unified ? (
                <>
                  Reading <span className="font-medium text-secondary">all inboxes</span> in one
                  list. Open a thread and reply — it routes through the right mailbox.
                </>
              ) : mailbox ? (
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

function UnreadPill({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="shrink-0 rounded-full bg-accent/15 px-1.5 font-mono text-[10px] font-medium leading-4 text-accent">
      {count > 999 ? '999+' : count}
    </span>
  );
}

function MailboxList({
  mailboxes,
  selectedId,
  onSelect,
  showAllInboxes,
  unreadByMailbox,
  totalUnread,
}: {
  mailboxes: MailboxPick[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  showAllInboxes: boolean;
  /** null = counts endpoint unavailable → no badges. */
  unreadByMailbox: Map<string, number> | null;
  totalUnread: number | null;
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
        {showAllInboxes && (
          <li className="border-b border-subtle pb-1.5 mb-1.5">
            <button
              type="button"
              onClick={() => onSelect(ALL_INBOXES)}
              aria-current={selectedId === ALL_INBOXES}
              className={cn(
                'flex w-full items-center gap-2 rounded-token px-2.5 py-2 text-left transition-colors duration-fast ease-token',
                selectedId === ALL_INBOXES
                  ? 'bg-surface-overlay text-primary shadow-token'
                  : 'text-tertiary hover:bg-surface-overlay/60 hover:text-primary',
              )}
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4 shrink-0 text-tertiary" aria-hidden="true">
                <path
                  d="M4 13l2-7a1 1 0 011-1h10a1 1 0 011 1l2 7M4 13v5a1 1 0 001 1h14a1 1 0 001-1v-5M4 13h4l2 2h4l2-2h4"
                  stroke="currentColor"
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
                All inboxes
              </span>
              {totalUnread != null && <UnreadPill count={totalUnread} />}
            </button>
          </li>
        )}
        {mailboxes.map((mb) => {
          const active = mb.id === selectedId;
          const tag = mb.provider ? PROVIDER_TAG[mb.provider] : null;
          const unread = unreadByMailbox?.get(mb.id) ?? null;
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
                  {unread != null && <UnreadPill count={unread} />}
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
  searchRef,
  query,
  onQuery,
  unified,
  selectable,
  selected,
  onToggleSelect,
  onToggleSelectAll,
  cursorThreadId,
  hasMore,
  loadingMore,
  onLoadMore,
  rowRefs,
}: {
  load: Load;
  error: string | null;
  threads: ThreadView[];
  selectedThreadId: string | null;
  onSelect: (thread: ThreadView) => void;
  onRetry: () => void;
  folder: MailFolder;
  onSelectFolder: (folder: MailFolder) => void;
  onManageSenders: () => void;
  searchRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (q: string) => void;
  unified: boolean;
  selectable: boolean;
  selected: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  cursorThreadId: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  rowRefs: RefObject<Map<string, HTMLLIElement>>;
}) {
  const searching = query.trim().length > 0;
  const allChecked = threads.length > 0 && selected.size >= threads.length;

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

      <div className="space-y-2 border-b border-subtle px-3 py-2">
        <SearchBar ref={searchRef} query={query} onQuery={onQuery} />
        {(selectable || searching) && threads.length > 0 && load === 'ready' && (
          <div className="flex items-center gap-2">
            {selectable && (
              <label className="inline-flex cursor-pointer select-none items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={onToggleSelectAll}
                  aria-label="Select all conversations in view"
                  className="h-3.5 w-3.5 cursor-pointer accent-accent"
                />
                <span className="text-[11px] text-tertiary">
                  {selected.size > 0 ? `${selected.size} selected` : 'Select all'}
                </span>
              </label>
            )}
            {searching && (
              <span className="ml-auto text-[11px] text-muted">
                {threads.length}
                {hasMore ? '+' : ''} {threads.length === 1 ? 'result' : 'results'}
              </span>
            )}
          </div>
        )}
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
        searching ? (
          <EmptySearch query={query} />
        ) : (
          <EmptyThreads folder={folder} />
        )
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {threads.map((t) => (
            <ThreadRow
              key={t.id}
              thread={t}
              active={t.id === selectedThreadId}
              cursor={t.id === cursorThreadId}
              unified={unified}
              selectable={selectable}
              checked={selected.has(t.id)}
              anySelected={selected.size > 0}
              onToggle={() => onToggleSelect(t.id)}
              onSelect={() => onSelect(t)}
              refCb={(el) => {
                if (el) rowRefs.current?.set(t.id, el);
                else rowRefs.current?.delete(t.id);
              }}
            />
          ))}
          {hasMore && (
            <li className="p-1.5">
              <Button
                variant="secondary"
                size="sm"
                block
                disabled={loadingMore}
                onClick={onLoadMore}
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </li>
          )}
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

/** Deterministic hue for a mailbox address (the per-account tag in All inboxes). */
function addressHue(address: string): number {
  let h = 0;
  for (let i = 0; i < address.length; i++) {
    h = (h * 31 + address.charCodeAt(i)) % 360;
  }
  return h;
}

function AccountTag({ address }: { address: string }) {
  const hue = addressHue(address.toLowerCase());
  const label = address.split('@')[0]?.slice(0, 12) || address.slice(0, 12);
  return (
    <span
      className="shrink-0 rounded-token px-1.5 font-mono text-[10px] leading-4"
      style={{
        backgroundColor: `hsl(${hue} 70% 50% / 0.16)`,
        color: `hsl(${hue} 65% 50%)`,
      }}
      title={address}
    >
      {label}
    </span>
  );
}

function PaperclipGlyph({ className }: { className?: string }) {
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

function ThreadRow({
  thread,
  active,
  cursor,
  unified,
  selectable,
  checked,
  anySelected,
  onToggle,
  onSelect,
  refCb,
}: {
  thread: ThreadView;
  active: boolean;
  cursor: boolean;
  unified: boolean;
  selectable: boolean;
  checked: boolean;
  anySelected: boolean;
  onToggle: () => void;
  onSelect: () => void;
  refCb: (el: HTMLLIElement | null) => void;
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
    <li ref={refCb}>
      <div
        className={cn(
          'group flex items-start rounded-token transition-colors duration-fast ease-token',
          active ? 'bg-surface-overlay shadow-token' : 'hover:bg-surface-overlay/60',
          cursor && 'ring-1 ring-inset ring-accent/50',
          checked && 'bg-accent/5',
        )}
      >
        {selectable && (
          <span
            className="flex shrink-0 items-center pl-2 pt-[13px]"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={onToggle}
              aria-label={`Select conversation: ${thread.subject?.trim() || '(no subject)'}`}
              className={cn(
                'h-3.5 w-3.5 cursor-pointer accent-accent transition-opacity duration-fast ease-token',
                checked || anySelected
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-100 max-lg:opacity-100',
              )}
            />
          </span>
        )}
        <button
          type="button"
          onClick={onSelect}
          aria-current={active}
          className={cn(
            'flex w-full min-w-0 flex-col gap-1 py-2 pr-2.5 text-left',
            selectable ? 'pl-1.5' : 'pl-2.5',
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
            {thread.has_attachments && (
              <PaperclipGlyph className="h-3 w-3 shrink-0 text-muted" />
            )}
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
            {unified && thread.mailbox_address && (
              <AccountTag address={thread.mailbox_address} />
            )}
            {thread.message_count > 1 && (
              <span className="shrink-0 rounded-token bg-surface-base px-1.5 font-mono text-[10px] text-muted">
                {thread.message_count}
              </span>
            )}
          </div>
        </button>
      </div>
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

function EmptySearch({ query }: { query: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-full bg-surface-overlay text-tertiary">
        <svg viewBox="0 0 24 24" fill="none" className="h-6 w-6" aria-hidden="true">
          <path
            d="M21 21l-4.3-4.3M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
          />
        </svg>
      </div>
      <p className="text-sm font-medium text-primary">No results</p>
      <p className="max-w-xs text-xs leading-5 text-tertiary">
        Nothing matches “{query}” in this folder. Try different words, or clear the search.
      </p>
    </div>
  );
}

// ── RIGHT: the open thread + reply composer ──────────────────────────────────

function ThreadPane({
  workspaceId,
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
  replySeed,
  replyRef,
  onSeedReply,
  onSeedReplyAll,
  onForward,
}: {
  workspaceId: string | null;
  mailbox: MailboxPick | null;
  /** The thread row (for subject/participants); may be null if not in the list. */
  thread: ThreadView | null;
  threadId: string | null;
  load: Load;
  error: string | null;
  messages: MessageView[];
  folder: MailFolder;
  onBack: () => void;
  onReply: UseMailClient['reply'];
  onTriage: (
    threadId: string,
    disposition: 'INBOX' | 'ARCHIVE' | 'TRASH' | 'SPAM',
    opts?: { blockSender?: boolean; trustSender?: boolean; senderAddress?: string },
  ) => Promise<TriageOutcome>;
  replySeed: ReplySeed;
  replyRef: RefObject<ReplyComposerHandle | null>;
  onSeedReply: (m: MessageView) => void;
  onSeedReplyAll: (m: MessageView) => void;
  onForward: (m: MessageView) => void;
}) {
  // Conversation UX: all but the last message collapse (unread ones stay open).
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const next = new Set<string>();
    const last = messages[messages.length - 1];
    if (last) next.add(last.id);
    for (const m of messages) if (m.is_unread) next.add(m.id);
    setExpanded(next);
  }, [threadId, messages]);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

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
              {mailbox && (
                <>
                  {' · '}
                  <span className="font-mono">{mailbox.email_address}</span>
                </>
              )}
            </p>
          )}
        </div>
        <TriageActions
          threadId={threadId}
          folder={folder}
          otherParty={replySeed.to[0] ?? null}
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
          <ul className="space-y-2.5 p-4">
            {messages.map((m) =>
              workspaceId ? (
                <MessageItem
                  key={m.id}
                  message={m}
                  workspaceId={workspaceId}
                  mailboxId={mailbox?.id ?? null}
                  collapsed={!expanded.has(m.id)}
                  onToggle={() => toggleExpanded(m.id)}
                  onReply={onSeedReply}
                  onReplyAll={onSeedReplyAll}
                  onForward={onForward}
                />
              ) : null,
            )}
          </ul>
        )}
      </div>

      {/* Reply composer — available whenever a thread is open. Remounts when a
          Reply/Reply-all seed is picked so the new defaults take. */}
      {load !== 'error' && (
        <ReplyComposer
          key={`${threadId}:${replySeed.nonce}`}
          ref={replyRef}
          defaultTo={replySeed.to}
          defaultCc={replySeed.cc}
          defaultSubject={replySeed.subject}
          workspaceId={workspaceId}
          mailboxId={mailbox?.id ?? null}
          inReplyTo={replySeed.inReplyTo}
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
            title="Archive (e)"
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
            title="Move to trash (#)"
          >
            Trash
          </Button>
        )}
      </div>
      {error && <p className="max-w-[14rem] text-right text-[11px] text-danger">{error}</p>}
    </div>
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
          Pick a thread from the list to read it and reply. Press{' '}
          <kbd className="rounded-token border border-border bg-surface-overlay px-1 font-mono text-[10px]">?</kbd>{' '}
          for keyboard shortcuts.
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

function dedupeAddresses(addresses: (string | null | undefined)[], exclude: string[]): string[] {
  const excluded = new Set(exclude.map((a) => a.toLowerCase()));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of addresses) {
    if (!a) continue;
    const key = a.toLowerCase();
    if (excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/**
 * Derive the default reply seed: address the conversation's *other* party (not
 * our own mailbox), and prefix the subject with "Re: " once. Prefers the latest
 * received message's sender; falls back to a thread participant. Also carries
 * the id of the message being replied to as the `in_reply_to` threading hint.
 */
function deriveReplyDefaults(
  messages: MessageView[],
  thread: ThreadView | null,
  mailbox: MailboxPick | null,
): ReplySeed {
  const self = mailbox?.email_address?.toLowerCase() ?? '';

  // Prefer the most recent inbound message's sender as the reply target.
  let to = '';
  let inReplyTo: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const from = messages[i].from?.address;
    if (from && from.toLowerCase() !== self) {
      to = from;
      inReplyTo = messages[i].id;
      break;
    }
  }
  // Fall back to a thread participant that isn't us.
  if (!to && thread) {
    const other = thread.participants.find((p) => p.address && p.address.toLowerCase() !== self);
    to = other?.address ?? thread.participants[0]?.address ?? '';
  }
  if (!inReplyTo && messages.length > 0) inReplyTo = messages[messages.length - 1].id;

  const subject = deriveReSubject(thread?.subject ?? lastSubject(messages));
  return { to: to ? [to] : [], cc: [], subject, inReplyTo, nonce: 0 };
}

/** Reply to a specific message: just its sender (or its recipients if it's ours). */
function deriveReplyToMessage(
  m: MessageView,
  selfAddress: string,
  thread: ThreadView | null,
): Omit<ReplySeed, 'nonce'> {
  const self = selfAddress.toLowerCase();
  const from = m.from?.address;
  const to =
    from && from.toLowerCase() !== self
      ? [from]
      : dedupeAddresses(m.to.map((p) => p.address), [selfAddress]).slice(0, 1);
  const subject = deriveReSubject(m.subject ?? thread?.subject ?? null);
  return { to, cc: [], subject, inReplyTo: m.id };
}

/**
 * Reply-all to a specific message: sender in To, every other recipient in Cc,
 * minus our own address, deduped.
 */
function deriveReplyAll(
  m: MessageView,
  selfAddress: string,
  thread: ThreadView | null,
): Omit<ReplySeed, 'nonce'> {
  const self = selfAddress ? [selfAddress] : [];
  const from = m.from?.address;
  const fromIsSelf = !!from && !!selfAddress && from.toLowerCase() === selfAddress.toLowerCase();
  const others = dedupeAddresses(
    [...m.to.map((p) => p.address), ...(m.cc ?? []).map((p) => p.address)],
    self,
  );
  const to = !fromIsSelf && from ? [from] : others.slice(0, 1);
  const cc = dedupeAddresses(others, to);
  const subject = deriveReSubject(m.subject ?? thread?.subject ?? null);
  return { to, cc, subject, inReplyTo: m.id };
}

/** Forward prefill: "Fwd:" subject, quoted original, attachments carried as blob refs. */
function buildForwardPrefill(m: MessageView, thread: ThreadView | null): ComposePrefill {
  const baseSubject = (m.subject ?? thread?.subject ?? '').trim();
  const subject = /^fwd:/i.test(baseSubject) ? baseSubject : `Fwd: ${baseSubject}`.trim();
  const fromLabel = m.from
    ? `${participantLabel(m.from)}${m.from.address ? ` <${m.from.address}>` : ''}`
    : 'Unknown';
  const lines: string[] = [
    '',
    '',
    '---------- Forwarded message ----------',
    `From: ${fromLabel}`,
  ];
  if (m.sent_at) lines.push(`Date: ${new Date(m.sent_at).toLocaleString()}`);
  lines.push(`Subject: ${baseSubject || '(no subject)'}`);
  if (m.to.length > 0) lines.push(`To: ${m.to.map((p) => p.address).filter(Boolean).join(', ')}`);
  if ((m.cc ?? []).length > 0) {
    lines.push(`Cc: ${(m.cc ?? []).map((p) => p.address).filter(Boolean).join(', ')}`);
  }
  lines.push('', m.text_body ?? m.preview ?? '');

  const attachments: UploadedBlob[] = (m.attachments ?? []).map((a) => ({
    blob_id: a.blob_id,
    name: a.name ?? 'attachment',
    type: a.type ?? 'application/octet-stream',
    size: a.size ?? 0,
  }));

  return {
    subject,
    body: lines.join('\n'),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
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

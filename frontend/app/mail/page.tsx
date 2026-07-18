'use client';

/**
 * Mail — the Agent Email Command Center (was the "retire Outlook" 3-pane).
 *
 * A mission-control, 5-zone surface reproducing the signed-off design:
 *   (1) 52px icon nav · (2) accounts + folders · (3) dense conversation list ·
 *   (4) reader (with the inline agent-draft card + pop-out) · (5) right
 *   agent-activity rail.
 *
 * Split typographic voice: monospace/tabular for machine data (timestamps,
 * addresses, counts, autonomy), sans for human content. Violet = an agent
 * touched this — the "Draft ready" chip in the list and the inline draft card in
 * the reader, both wired to the real agent-inbox approve/reject endpoints.
 *
 * All the webmail-wave behaviour is preserved: debounced search, selection +
 * bulk bar, offset paging, unified "All inboxes", attachments, compose with
 * cc/bcc/reply-all/forward, the Gmail-style keyboard layer, the agent
 * UiCommandBridge (open_thread / compose), and light/dark + mobile single-column.
 * Every Wave-2 endpoint stays feature-detected; the agent surfaces degrade clean
 * when their endpoints are absent.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { Button, Skeleton, cn } from '@/components/ui';
import { useActiveSpace } from '@/components/ActiveSpaceProvider';
import { useUiCommands } from '@/components/UiCommandProvider';
import { useMailboxCollapsed, useRailCollapsed } from '@/state/uiCollapse';
import { useTheme } from '@/state/theme';
import { useAgentInbox } from '@/components/useAgentInbox';
import { useAgents } from '@/components/useAgents';
import { useAgentControls } from '@/components/useAgentControls';
import { agentLabel } from '@/lib/agents';
import type { AgentInboxItemView, AutonomyLevel } from '@/lib/api';
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
import { BulkBar } from '@/components/mail/BulkBar';
import { ShortcutsHelp } from '@/components/mail/ShortcutsHelp';
import { useMailShortcuts } from '@/components/mail/useMailShortcuts';
import { CommandPalette, type CommandAction } from '@/components/mail/CommandPalette';
import { MailTopBar } from '@/components/mail/MailTopBar';
import { MailIconNav } from '@/components/mail/MailIconNav';
import { AgentRail } from '@/components/mail/AgentRail';
import { AgentDraftCard } from '@/components/mail/AgentDraftCard';
import { MessagePopout } from '@/components/mail/MessagePopout';
import {
  MailIcon,
  InboxTrayIcon,
  SendIcon,
  ArchiveIcon,
  TrashIcon,
  ReplyIcon,
  PopOutIcon,
  PlusIcon,
  CheckSquareIcon,
  StarIcon,
  BanIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  SlidersIcon,
  RobotIcon,
  FolderIcon,
  PencilIcon,
  CloseIcon,
} from '@/components/mail/icons';
import type {
  BulkAction,
  MailboxPick,
  MailFolder,
  MailFolderView,
  MessageView,
  ThreadView,
  UploadedBlob,
} from '@/lib/mailApi';

/** The folder tabs, in display order. */
const FOLDERS: { id: MailFolder; label: string }[] = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'sent', label: 'Sent' },
  { id: 'drafts', label: 'Drafts' },
  { id: 'archive', label: 'Archive' },
  { id: 'spam', label: 'Spam' },
  { id: 'trash', label: 'Trash' },
];

const FOLDER_GLYPH: Record<MailFolder, (p: { className?: string }) => ReactNode> = {
  inbox: InboxTrayIcon,
  sent: SendIcon,
  drafts: ReplyIcon,
  archive: ArchiveIcon,
  spam: BanIcon,
  trash: TrashIcon,
};

const AUTONOMY_BADGE: Record<AutonomyLevel, string> = {
  L0_DRAFT_ONLY: 'L0 · DRAFT ONLY',
  L1_APPROVE_TO_SEND: 'L1 · APPROVE TO SEND',
  L2_AUTONOMOUS_AUDIT: 'L2 · AUTONOMOUS',
};

/** A composer prefill carried by an agent's `ui_compose` (Phase C) or Forward. */
interface ComposePrefill extends ComposeDialogPrefill {
  thread_id?: string;
}

/** A reply-composer seed (default derive, or Reply / Reply-all on a message). */
interface ReplySeed {
  to: string[];
  cc: string[];
  subject: string;
  inReplyTo: string | null;
  nonce: number;
}

function draftPrefillFromMessage(message: MessageView): ComposePrefill {
  return {
    to: message.to.map((p) => p.address),
    cc: message.cc?.map((p) => p.address) ?? [],
    bcc: message.bcc?.map((p) => p.address) ?? [],
    subject: message.subject ?? '',
    body: message.text_body ?? '',
    bodyHtml: message.html_body ?? undefined,
    draftId: message.id,
    attachments:
      message.attachments?.map((a) => ({
        blob_id: a.blob_id,
        name: a.name ?? 'attachment',
        type: a.type ?? 'application/octet-stream',
        size: a.size ?? 0,
      })) ?? [],
  };
}

type SegFilter = 'all' | 'unread' | 'starred' | 'agent';

export default function MailPage() {
  const mail = useMailClient();
  const { activeSpace } = useActiveSpace();
  const { version, consumeLocal } = useUiCommands();

  // Agent data layer (reused, single-fetch): approvals + fleet + kill switch.
  const inbox = useAgentInbox();
  const agents = useAgents();
  const { agentsPaused, setPaused } = useAgentControls();

  const [composeOpen, setComposeOpen] = useState(false);
  const [composeInitial, setComposeInitial] = useState<ComposePrefill | null>(null);
  const [sendersOpen, setSendersOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [popoutOpen, setPopoutOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [filter, setFilter] = useState<SegFilter>('all');

  // Chrome collapse state (reused folders store + new rail store).
  const [foldersCollapsed, toggleFolders] = useMailboxCollapsed();
  const [railCollapsed, toggleRail] = useRailCollapsed();

  // Selection (bulk actions) + keyboard cursor over the thread list.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [cursor, setCursor] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);
  const replyRef = useRef<ReplyComposerHandle>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  // After triaging the OPEN thread, advance to the conversation that shifts into
  // its slot. Holds that pre-triage index until the refreshed list consumes it.
  const advanceAfterTriageRef = useRef<number | null>(null);

  const [replySeed, setReplySeed] = useState<ReplySeed | null>(null);
  // The inline reply composer is on-demand: collapsed to a compact action bar
  // until the user picks Reply / Reply all (Forward opens the full dialog).
  const [composerOpen, setComposerOpen] = useState(false);
  const threadOpen = mail.selectedThreadId !== null;
  const router = useRouter();

  // ── Debounced command-bar search (the box lives in the top bar) ─────────────
  const { setQuery } = mail;
  const [searchDraft, setSearchDraft] = useState(mail.query);
  useEffect(() => setSearchDraft(mail.query), [mail.query]);
  const searchTimer = useRef<number | undefined>(undefined);
  const onSearchInput = useCallback(
    (v: string) => {
      setSearchDraft(v);
      window.clearTimeout(searchTimer.current);
      searchTimer.current = window.setTimeout(() => setQuery(v), 300);
    },
    [setQuery],
  );

  // ── Phase C: agent-staged page-local commands (open_thread / compose) ───────
  const { selectMailbox, selectThread } = mail;
  const selectedMailboxIdRef = useRef<string | null>(null);
  selectedMailboxIdRef.current = mail.unified ? ALL_INBOXES : mail.selectedMailbox?.id ?? null;
  const pendingOpenRef = useRef<{ mailboxId: string; threadId: string } | null>(null);

  useEffect(() => {
    const openThread = consumeLocal('open_thread');
    if (openThread) {
      const { mailbox_id, thread_id } = openThread.payload;
      if (mailbox_id && mailbox_id !== selectedMailboxIdRef.current) {
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

  const { selectedMailbox, threadsLoad } = mail;
  useEffect(() => {
    const pending = pendingOpenRef.current;
    if (!pending) return;
    if (selectedMailbox?.id !== pending.mailboxId) return;
    if (threadsLoad !== 'ready') return;
    pendingOpenRef.current = null;
    selectThread(pending.threadId, pending.mailboxId);
  }, [selectedMailbox?.id, threadsLoad, selectThread]);

  // Scope the mailbox picker to the active Space (purely client-side).
  const visibleMailboxes = useMemo(() => {
    if (!activeSpace) return mail.mailboxes;
    const allowed = new Set(activeSpace.mailbox_ids);
    return mail.mailboxes.filter((m) => allowed.has(m.id));
  }, [mail.mailboxes, activeSpace]);

  const selectedVisible =
    mail.unified || visibleMailboxes.some((m) => m.id === mail.selectedMailbox?.id);

  const { load: mailLoad } = mail;
  useEffect(() => {
    if (mailLoad !== 'ready') return;
    if (!activeSpace) return;
    if (visibleMailboxes.length === 0) return;
    if (!selectedVisible) selectMailbox(visibleMailboxes[0].id);
  }, [mailLoad, activeSpace, visibleMailboxes, selectedVisible, selectMailbox]);

  // ── Selection + cursor housekeeping ─────────────────────────────────────────
  const threads = mail.threads;

  // Pending agent drafts (the violet signal) — pending items only.
  const pendingItems = useMemo(
    () => inbox.items.filter((i) => i.state === 'pending'),
    [inbox.items],
  );
  const draftForThread = useCallback(
    (thread: ThreadView | null): AgentInboxItemView | null => {
      if (!thread || pendingItems.length === 0) return null;
      // 1) explicit thread id in the item payload.
      for (const it of pendingItems) {
        const p = it.payload ?? {};
        const tid = (p.thread_id ?? p.in_reply_to_thread_id ?? p.conversation_id) as
          | string
          | undefined;
        if (tid && String(tid) === thread.id) return it;
      }
      // 2) fallback: normalized subject + a matching recipient/participant.
      const nsub = normSubject(thread.subject);
      if (!nsub) return null;
      const parts = new Set(
        thread.participants.map((p) => p.address?.toLowerCase()).filter(Boolean) as string[],
      );
      for (const it of pendingItems) {
        // Subject-only fallback must still pin to a real participant — a
        // draft with no recipient must NOT paint onto every same-subject
        // thread, so require a concrete to_address that matches a participant.
        if (it.subject && normSubject(it.subject) === nsub) {
          if (it.to_address && parts.has(it.to_address.toLowerCase())) return it;
        }
      }
      return null;
    },
    [pendingItems],
  );

  // Segmented filter over the current list (All / Unread / Agent).
  const displayThreads = useMemo(() => {
    if (filter === 'unread') return threads.filter((t) => t.unread);
    if (filter === 'starred') return threads.filter((t) => t.flagged);
    if (filter === 'agent') return threads.filter((t) => draftForThread(t) !== null);
    return threads;
  }, [threads, filter, draftForThread]);

  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const inList = new Set(threads.map((t) => t.id));
      const next = new Set([...prev].filter((id) => inList.has(id)));
      return next.size === prev.size ? prev : next;
    });
    setCursor((c) => Math.min(c, displayThreads.length - 1));
  }, [threads, displayThreads.length]);

  // One-pass auto-advance: when a triage armed a target index, re-open whatever
  // conversation now occupies that slot in the refreshed list (clamped), or fall
  // back to the empty state when the list drained.
  useEffect(() => {
    const idx = advanceAfterTriageRef.current;
    if (idx === null) return;
    advanceAfterTriageRef.current = null;
    if (displayThreads.length === 0) {
      selectThread(null);
      return;
    }
    const next = displayThreads[Math.min(idx, displayThreads.length - 1)];
    if (next) selectThread(next.id, next.mailbox_id);
    else selectThread(null);
  }, [displayThreads, selectThread]);

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
      prev.size >= displayThreads.length ? new Set() : new Set(displayThreads.map((t) => t.id)),
    );
  }, [displayThreads]);

  // ── Open-thread context ─────────────────────────────────────────────────────
  const openThreadRow = threads.find((t) => t.id === mail.selectedThreadId) ?? null;
  const threadMailbox =
    mail.mailboxes.find((m) => m.id === mail.selectedThreadMailboxId) ?? mail.selectedMailbox;
  const selfAddress = threadMailbox?.email_address ?? mail.composeMailbox?.email_address ?? '';
  // Every mailbox address is "you" — used to strip the account owner out of the
  // conversation-row sender line so the list shows the OTHER party, never yourself.
  const selfAddresses = useMemo(
    () =>
      new Set(
        mail.mailboxes
          .map((m) => m.email_address?.toLowerCase().trim())
          .filter(Boolean) as string[],
    ),
    [mail.mailboxes],
  );
  const openDraft = draftForThread(openThreadRow);
  const autoOpenedDraftThread = useRef<string | null>(null);

  useEffect(() => {
    if (mail.folder !== 'drafts' || !openThreadRow || mail.messages.length === 0) {
      autoOpenedDraftThread.current = null;
      return;
    }
    if (composeOpen) return;
    if (autoOpenedDraftThread.current === openThreadRow.id) return;
    const draftMessage =
      [...mail.messages].reverse().find((m) => m.direction === 'draft') ?? mail.messages[mail.messages.length - 1];
    if (!draftMessage) return;
    setComposeInitial(draftPrefillFromMessage(draftMessage));
    setComposeOpen(true);
    autoOpenedDraftThread.current = openThreadRow.id;
  }, [mail.folder, openThreadRow, mail.messages, composeOpen]);

  const defaultReply = useMemo(
    () => deriveReplyDefaults(mail.messages, openThreadRow, threadMailbox),
    [mail.messages, openThreadRow, threadMailbox],
  );
  const activeSeed = replySeed ?? defaultReply;

  useEffect(() => {
    setReplySeed(null);
    setComposerOpen(false);
  }, [mail.selectedThreadId]);

  // Every reply entry point (r-key, toolbar Reply, message Reply/Reply-all) funnels
  // through here — so opening the composer + focusing it lives in one place.
  const focusReplySoon = useCallback(() => {
    setComposerOpen(true);
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

  const openCompose = useCallback(() => {
    setComposeInitial(null);
    setComposeOpen(true);
  }, []);

  // ── Bulk actions ─────────────────────────────────────────────────────────────
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

  // ── Keyboard layer ────────────────────────────────────────────────────────────
  const lastMessage = mail.messages[mail.messages.length - 1] ?? null;
  const cursorThread = cursor >= 0 ? displayThreads[cursor] ?? null : null;

  const moveCursor = useCallback(
    (delta: 1 | -1) => {
      if (displayThreads.length === 0) return;
      setCursor((c) => {
        const next =
          c < 0
            ? delta > 0
              ? 0
              : displayThreads.length - 1
            : Math.min(displayThreads.length - 1, Math.max(0, c + delta));
        const id = displayThreads[next]?.id;
        if (id) rowRefs.current.get(id)?.scrollIntoView({ block: 'nearest' });
        return next;
      });
    },
    [displayThreads],
  );

  const keyboardTargetId = mail.selectedThreadId ?? cursorThread?.id ?? null;

  // Triage a thread and, when it's the OPEN one, arm a one-pass auto-advance:
  // remember the row's index now so the refreshed list can re-open whatever
  // conversation slides into that slot. Only the open thread advances.
  const { triage: mailTriage, selectedThreadId } = mail;
  const triageAndAdvance = useCallback(
    (
      threadId: string,
      disposition: 'INBOX' | 'ARCHIVE' | 'TRASH' | 'SPAM',
      opts?: { blockSender?: boolean; trustSender?: boolean; senderAddress?: string },
    ): Promise<TriageOutcome> => {
      const isOpen = threadId === selectedThreadId;
      if (isOpen) {
        const idx = displayThreads.findIndex((t) => t.id === threadId);
        advanceAfterTriageRef.current = idx >= 0 ? idx : null;
      }
      const p = mailTriage(threadId, disposition, opts);
      if (isOpen) {
        void p.then((res) => {
          if (!res.ok) advanceAfterTriageRef.current = null;
        });
      }
      return p;
    },
    [mailTriage, selectedThreadId, displayThreads],
  );

  const shortcutTriage = useCallback(
    (disposition: 'ARCHIVE' | 'TRASH') => {
      const bulkAction: BulkAction = disposition === 'ARCHIVE' ? 'archive' : 'trash';
      if (selected.size > 0 && mail.features.bulk) {
        void runBulk(bulkAction);
        return;
      }
      if (keyboardTargetId) void triageAndAdvance(keyboardTargetId, disposition);
    },
    [selected, mail.features.bulk, runBulk, keyboardTargetId, triageAndAdvance],
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
        const t = cursorThread ?? displayThreads[0];
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
      onCompose: openCompose,
      onHelp: () => setHelpOpen(true),
    },
    !composeOpen && !sendersOpen && !helpOpen && !popoutOpen && !paletteOpen,
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

  // Re-open the current thread to re-run its messages fetch (used by the reader's
  // error-retry). Re-selecting mints a fresh open-thread ref → the loader re-fires.
  const { selectedThreadMailboxId } = mail;
  const reloadOpenThread = useCallback(() => {
    if (selectedThreadId) selectThread(selectedThreadId, selectedThreadMailboxId ?? undefined);
  }, [selectThread, selectedThreadId, selectedThreadMailboxId]);

  // ── ⌘K command palette actions (built from the real handlers) ───────────────
  const { selectFolder } = mail;
  const commandActions = useMemo<CommandAction[]>(() => {
    const list: CommandAction[] = [];

    // Navigate — folders
    for (const f of FOLDERS) {
      const Glyph = FOLDER_GLYPH[f.id];
      list.push({
        id: `folder:${f.id}`,
        label: f.label,
        group: 'Navigate',
        icon: <Glyph />,
        keywords: `folder go to ${f.label}`,
        run: () => selectFolder(f.id),
      });
    }
    // Navigate — segment filters
    list.push(
      {
        id: 'filter:all',
        label: 'All mail',
        group: 'Navigate',
        icon: <MailIcon />,
        keywords: 'filter show everything all',
        run: () => setFilter('all'),
      },
      {
        id: 'filter:unread',
        label: 'Unread',
        group: 'Navigate',
        icon: <CheckSquareIcon />,
        keywords: 'filter unseen new unread',
        run: () => setFilter('unread'),
      },
      {
        id: 'filter:agent',
        label: 'Agent drafts',
        group: 'Navigate',
        icon: <RobotIcon />,
        keywords: 'filter agent draft ready violet',
        run: () => setFilter('agent'),
      },
    );

    // Accounts — unified + each mailbox
    if (showAllInboxes) {
      list.push({
        id: 'mailbox:all',
        label: 'All inboxes',
        group: 'Accounts',
        icon: <MailIcon />,
        keywords: 'unified merge every mailbox account inbox',
        run: () => selectMailbox(ALL_INBOXES),
      });
    }
    for (const mb of visibleMailboxes) {
      list.push({
        id: `mailbox:${mb.id}`,
        label: mb.display_name?.trim() || mb.email_address,
        group: 'Accounts',
        icon: <MailIcon />,
        keywords: `account mailbox ${mb.email_address}`,
        run: () => selectMailbox(mb.id),
      });
    }

    // Actions — always Compose; thread-scoped ones only with a thread open.
    list.push({
      id: 'action:compose',
      label: 'Compose',
      group: 'Actions',
      hint: 'C',
      icon: <PlusIcon />,
      keywords: 'new message write email compose',
      run: openCompose,
    });
    if (selectedThreadId) {
      list.push(
        {
          id: 'action:reply',
          label: 'Reply',
          group: 'Actions',
          hint: 'R',
          icon: <ReplyIcon />,
          keywords: 'respond answer reply',
          run: () => focusReplySoon(),
        },
        {
          id: 'action:reply-all',
          label: 'Reply all',
          group: 'Actions',
          hint: 'A',
          icon: <ReplyIcon />,
          keywords: 'respond everyone reply all',
          disabled: !lastMessage,
          run: () => {
            if (lastMessage) seedReplyAll(lastMessage);
          },
        },
        {
          id: 'action:forward',
          label: 'Forward',
          group: 'Actions',
          hint: 'F',
          icon: <SendIcon />,
          keywords: 'forward send on fwd',
          disabled: !lastMessage,
          run: () => {
            if (lastMessage) forwardMessage(lastMessage, openThreadRow);
          },
        },
        {
          id: 'action:archive',
          label: 'Archive',
          group: 'Actions',
          hint: 'E',
          icon: <ArchiveIcon />,
          keywords: 'archive file done',
          run: () => shortcutTriage('ARCHIVE'),
        },
        {
          id: 'action:trash',
          label: 'Move to trash',
          group: 'Actions',
          hint: '#',
          icon: <TrashIcon />,
          keywords: 'trash delete remove bin',
          run: () => shortcutTriage('TRASH'),
        },
        {
          id: 'action:mark-read',
          label: 'Mark read',
          group: 'Actions',
          icon: <CheckSquareIcon />,
          keywords: 'mark read seen',
          run: () => shortcutMark(true),
        },
        {
          id: 'action:mark-unread',
          label: 'Mark unread',
          group: 'Actions',
          keywords: 'mark unread unseen',
          run: () => shortcutMark(false),
        },
      );
    }

    // Help
    list.push({
      id: 'help:shortcuts',
      label: 'Keyboard shortcuts',
      group: 'Help',
      hint: '?',
      keywords: 'help keyboard shortcuts keys cheatsheet',
      run: () => setHelpOpen(true),
    });

    return list;
  }, [
    selectFolder,
    selectMailbox,
    showAllInboxes,
    visibleMailboxes,
    selectedThreadId,
    lastMessage,
    openThreadRow,
    focusReplySoon,
    seedReplyAll,
    forwardMessage,
    shortcutTriage,
    shortcutMark,
    openCompose,
  ]);

  const canCompose =
    mail.load === 'ready' &&
    !!mail.workspace &&
    (mail.unified ? visibleMailboxes.length > 0 : selectedVisible);

  const activeAgentCount =
    agents.load === 'ready' ? agents.items.filter((a) => a.active && !a.paused).length : null;

  const selectedMailboxId = mail.unified ? null : mail.selectedMailbox?.id ?? null;

  // Top-level non-ready banner (rendered inside the list column).
  const banner: ListBanner | null =
    !mail.workspace && mail.load === 'ready'
      ? 'no-workspace'
      : mail.load === 'error'
        ? 'error'
        : mail.load === 'loading'
          ? 'loading'
          : mail.mailboxes.length === 0
            ? 'no-mailboxes'
            : visibleMailboxes.length === 0
              ? 'no-space'
              : null;

  // The 4-column grid (folders · list · reader · rail). iconnav is a flex sibling.
  // Collapsed, the folders pane becomes a slim 56px avatar rail (never 0) so the
  // webmail never fully vanishes.
  const gridCols = `${foldersCollapsed ? '56px' : '236px'} minmax(300px,1.15fr) minmax(360px,1.9fr) ${
    railCollapsed ? '44px' : '320px'
  }`;

  const listTitle = mail.unified
    ? 'All inboxes'
    : mail.selectedMailbox?.display_name?.trim() || mail.selectedMailbox?.email_address || 'Mailbox';
  const listUnread = mail.unified
    ? totalUnread
    : selectedMailboxId
      ? unreadByMailbox?.get(selectedMailboxId) ?? null
      : null;

  // Daily brief shown in the reader when no thread is open — assembled from
  // data already in hand (no extra fetch), with one-key ways to start working.
  const firstUnread = displayThreads.find((t) => t.unread) ?? null;
  // The per-mailbox aggregate can lag/read 0 for Stalwart mailboxes even when
  // rows are flagged unread — never show 0 next to a visibly-unread list; fall
  // back to at least the count of loaded unread threads.
  const loadedUnread = displayThreads.reduce((n, t) => n + (t.unread ? 1 : 0), 0);

  // Reflect the mailbox's inbox-unread count in the browser tab title so a
  // backgrounded tab surfaces new mail (Gmail-style). On the inbox we take the
  // Stalwart-lag-safe max the rest of the surface uses; other folders show the
  // mailbox's inbox-unread from the counts endpoint. 0 unread → no prefix.
  const titleUnread = Math.max(listUnread ?? 0, mail.folder === 'inbox' ? loadedUnread : 0);
  useEffect(() => {
    document.title = titleUnread > 0 ? `(${titleUnread}) Email-Ops` : 'Email-Ops';
  }, [titleUnread]);

  // Light view digest for the agent chat — subjects/senders only, never bodies —
  // evaluated at send time so the assistant grounds answers in the current view.
  const getChatContext = useCallback((): Record<string, unknown> => {
    const threads = displayThreads.slice(0, 25).map((t) => {
      const other = t.participants.find(
        (p) => !p.address || !selfAddresses.has(p.address.toLowerCase().trim()),
      );
      return {
        // thread_id + from_address let the assistant thread a reply to the right
        // conversation and address the right person (metadata only, never bodies).
        thread_id: t.id,
        from: other?.name?.trim() || other?.address || 'Unknown',
        from_address: other?.address ?? null,
        subject: t.subject?.trim() || '(no subject)',
        snippet: (t.last_snippet ?? '').slice(0, 140),
        unread: !!t.unread,
      };
    });
    return {
      mailbox: listTitle,
      folder: mail.folder,
      unread_count: Math.max(listUnread ?? 0, loadedUnread),
      thread_count: displayThreads.length,
      threads,
    };
  }, [displayThreads, selfAddresses, listTitle, mail.folder, listUnread, loadedUnread]);

  const brief: BriefData = {
    mailboxName: listTitle,
    unread: Math.max(listUnread ?? 0, loadedUnread) || null,
    pendingCount: inbox.pendingCount,
    agentsLive: activeAgentCount,
    mailboxCount: visibleMailboxes.length,
    pending: pendingItems.slice(0, 3),
    hasUnread: firstUnread !== null,
    onStartTriage: () => {
      if (firstUnread) selectThread(firstUnread.id, firstUnread.mailbox_id);
    },
    onCompose: openCompose,
    onReviewApprovals: () => router.push('/agent-inbox'),
    onReviewItem: (it) => {
      const p = it.payload ?? {};
      const tid = (p.thread_id ?? p.in_reply_to_thread_id ?? p.conversation_id) as
        | string
        | undefined;
      if (tid) selectThread(String(tid), (p.mailbox_id as string | undefined) ?? undefined);
      else router.push('/agent-inbox');
    },
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-surface-base text-primary">
      <MailTopBar
        query={searchDraft}
        onQuery={onSearchInput}
        searchRef={searchRef}
        foldersCollapsed={foldersCollapsed}
        onToggleFolders={toggleFolders}
        railCollapsed={railCollapsed}
        onToggleRail={toggleRail}
        agentsPaused={agentsPaused}
        onTogglePause={() => setPaused(!agentsPaused)}
        activeAgentCount={activeAgentCount}
        onRefresh={mail.refresh}
        refreshing={mail.refreshing}
        onCompose={openCompose}
        canCompose={canCompose}
        onHelp={() => setHelpOpen(true)}
        onCommandPalette={() => setPaletteOpen(true)}
      />

      <div className="flex min-h-0 flex-1">
        <MailIconNav pendingCount={inbox.pendingCount} />

        <div
          className="grid min-h-0 flex-1 grid-cols-1 transition-[grid-template-columns] duration-token ease-token lg:[grid-template-columns:var(--cols)]"
          style={{ '--cols': gridCols } as CSSProperties}
        >
          {/* (2) accounts + folders — hidden on mobile. Collapses to a slim
              avatar rail (never fully vanishes) instead of disappearing. */}
          <div className="overflow-hidden max-lg:hidden">
            {foldersCollapsed ? (
              <FoldersRail
                mailboxes={visibleMailboxes}
                selectedId={
                  mail.unified
                    ? ALL_INBOXES
                    : selectedVisible
                      ? mail.selectedMailbox?.id ?? null
                      : null
                }
                onSelect={mail.selectMailbox}
                showAllInboxes={showAllInboxes}
                unreadByMailbox={unreadByMailbox}
                totalUnread={totalUnread}
                folder={mail.folder}
                onSelectFolder={mail.selectFolder}
                pendingCount={inbox.pendingCount}
                onExpand={toggleFolders}
              />
            ) : (
              <FoldersColumn
                mailboxes={visibleMailboxes}
                selectedId={
                  mail.unified
                    ? ALL_INBOXES
                    : selectedVisible
                      ? mail.selectedMailbox?.id ?? null
                      : null
                }
                onSelect={mail.selectMailbox}
                showAllInboxes={showAllInboxes}
                unreadByMailbox={unreadByMailbox}
                totalUnread={totalUnread}
                folder={mail.folder}
                onSelectFolder={mail.selectFolder}
                pendingCount={inbox.pendingCount}
                onManageSenders={() => setSendersOpen(true)}
                onCollapse={toggleFolders}
                foldersEnabled={
                  !mail.unified &&
                  !!mail.selectedMailbox &&
                  mail.foldersSupported &&
                  mail.selectedMailbox.provider !== 'gmail' &&
                  mail.selectedMailbox.provider !== 'microsoft'
                }
                customFolders={mail.customFolders}
                activeCustomFolderId={mail.activeCustomFolderId}
                onSelectCustomFolder={mail.selectCustomFolder}
                onCreateFolder={mail.createFolder}
                onRenameFolder={mail.renameFolder}
                onDeleteFolder={mail.deleteFolder}
              />
            )}
          </div>

          {/* (3) conversation list — the only left pane on mobile until a thread opens. */}
          <section
            className={cn(
              'flex min-w-0 flex-col overflow-hidden border-r border-subtle bg-surface-base',
              threadOpen && 'max-lg:hidden',
            )}
          >
            <ConversationList
              banner={banner}
              error={mail.threadsError ?? mail.error}
              title={listTitle}
              unreadCount={listUnread}
              filter={filter}
              onFilter={setFilter}
              folder={mail.folder}
              spaceName={activeSpace?.name ?? null}
              load={mail.threadsLoad}
              threads={displayThreads}
              selectedThreadId={mail.selectedThreadId}
              onSelect={(t) => selectThread(t.id, t.mailbox_id)}
              onRetry={mail.refreshThreads}
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
              draftForThread={draftForThread}
              selfAddresses={selfAddresses}
              onQuickTriage={(id, d) => void triageAndAdvance(id, d)}
              onQuickMark={(id, read) => mail.markRead([id], read)}
              onToggleFlag={(id, flagged) => mail.toggleFlag(id, flagged)}
              onEmptyFolder={
                !mail.unified && (mail.folder === 'trash' || mail.folder === 'spam')
                  ? () => {
                      const target = mail.folder === 'trash' ? 'trash' : 'spam';
                      const label = target === 'trash' ? 'Trash' : 'Spam';
                      if (!window.confirm(`Permanently delete all messages in ${label}? This cannot be undone.`)) return;
                      void mail.emptyFolder(target).then((res) => {
                        if (!res.ok && res.error) window.alert(res.error);
                      });
                    }
                  : undefined
              }
            />
          </section>

          {/* (4) reader — the only pane shown on mobile when a thread is open. */}
          <section
            className={cn(
              'flex min-w-0 flex-col overflow-hidden border-l border-subtle',
              !threadOpen && 'max-lg:hidden',
            )}
          >
            <Reader
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
              onTriage={triageAndAdvance}
              onMoveToFolder={mail.moveThreadToFolder}
              customFolders={mail.customFolders}
              onReload={reloadOpenThread}
              replySeed={activeSeed}
              replyRef={replyRef}
              onSeedReply={seedReply}
              onSeedReplyAll={seedReplyAll}
              onForward={(m) => forwardMessage(m, openThreadRow)}
              onFocusReply={focusReplySoon}
              composerOpen={composerOpen}
              onCollapseComposer={() => setComposerOpen(false)}
              onPopout={() => setPopoutOpen(true)}
              onToggleFlag={(flagged) => openThreadRow && mail.toggleFlag(openThreadRow.id, flagged)}
              draft={openDraft}
              draftAutonomyLabel={
                openDraft ? autonomyBadgeFor(openDraft, agents.items) : ''
              }
              brief={brief}
              onApproveDraft={() => inbox.approve(openDraft!.id)}
              onDiscardDraft={() => inbox.reject(openDraft!.id)}
              onEditDraft={() => {
                if (!openDraft) return;
                setComposeInitial({
                  to: openDraft.to_address ? [openDraft.to_address] : [],
                  subject: openDraft.subject ?? '',
                  body: openDraft.body_preview ?? '',
                  thread_id: openThreadRow?.id,
                });
                setComposeOpen(true);
              }}
            />
          </section>

          {/* (5) right agent-activity rail — desktop only. */}
          <div className={cn('hidden lg:block', 'overflow-hidden')}>
            <AgentRail
              collapsed={railCollapsed}
              onExpand={toggleRail}
              onCollapse={toggleRail}
              pendingCount={inbox.pendingCount}
              agents={agents.items}
              agentsAvailable={agents.load === 'ready'}
              selectedMailboxId={selectedMailboxId}
              paused={agentsPaused}
              onSetAutonomy={(agentId, level) =>
                agents.update(agentId, { autonomy_level: level })
              }
              getChatContext={getChatContext}
            />
          </div>
        </div>
      </div>

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

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} actions={commandActions} />

      <MessagePopout
        open={popoutOpen && threadOpen}
        onClose={() => setPopoutOpen(false)}
        subject={openThreadRow?.subject?.trim() || '(no subject)'}
        messages={mail.messages}
        workspaceId={mail.workspace?.workspace_id ?? null}
        mailboxId={threadMailbox?.id ?? null}
      />
    </div>
  );
}

// ── (2) Accounts + folders column ─────────────────────────────────────────────

/** Deterministic hue for a mailbox address (the per-account tag). */
function addressHue(address: string): number {
  let h = 0;
  for (let i = 0; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) % 360;
  return h;
}

/**
 * Deterministic avatar fill for a sender — a same-hue gradient keyed off the
 * address, matching the per-account color-dot hue so a sender reads the same
 * colour in the list, the reader, and its account tag. Mid-lightness stops keep
 * white initials legible on both dark and light themes.
 */
function avatarHueStyle(seed: string): CSSProperties {
  const h = addressHue((seed || 'x').toLowerCase());
  return { background: `linear-gradient(140deg, hsl(${h} 70% 56%), hsl(${h} 62% 45%))` };
}

type FolderActionResult = { ok: boolean; error?: string };

/**
 * The custom-folders block in the expanded folder rail: list + create + rename +
 * delete + select. The page renders it ONLY for a single sovereign (James)
 * mailbox. Folders are a HUMAN action, so this stays on the neutral accent/surface
 * tokens — never the agent-violet signal — and every write reports the truthful
 * backend status (a create/rename/delete that could not apply surfaces inline,
 * never a fake success).
 */
function CustomFoldersSection({
  folders,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: {
  folders: MailFolderView[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<FolderActionResult>;
  onRename: (id: string, name: string) => Promise<FolderActionResult>;
  onDelete: (id: string) => Promise<FolderActionResult>;
}) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputCls =
    'w-full rounded-md border border-subtle bg-surface-base px-2 py-1 text-[13px] text-primary outline-none transition-colors focus:border-accent disabled:opacity-60';

  const closeCreate = () => {
    setCreating(false);
    setDraft('');
    setError(null);
  };
  const submitCreate = async () => {
    const name = draft.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    const res = await onCreate(name);
    setBusy(false);
    if (res.ok) closeCreate();
    else setError(res.error ?? 'Could not create the folder.');
  };
  const closeRename = () => {
    setRenamingId(null);
    setRenameDraft('');
  };
  const submitRename = async (id: string) => {
    const name = renameDraft.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    const res = await onRename(id, name);
    setBusy(false);
    if (res.ok) closeRename();
    else setError(res.error ?? 'Could not rename the folder.');
  };
  const submitDelete = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await onDelete(id);
    setBusy(false);
    setConfirmDeleteId(null);
    if (!res.ok) setError(res.error ?? 'Could not delete the folder.');
  };

  return (
    <>
      <div className="mt-1 flex items-center justify-between px-3.5 pb-1 pt-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.09em] text-tertiary">
          Custom folders
        </h3>
        <button
          type="button"
          onClick={() => (creating ? closeCreate() : setCreating(true))}
          aria-label={creating ? 'Cancel new folder' : 'New folder'}
          title={creating ? 'Cancel' : 'New folder'}
          className="grid h-[20px] w-[20px] place-items-center rounded-md text-tertiary transition-colors hover:bg-surface-overlay hover:text-secondary"
        >
          {creating ? <CloseIcon className="h-3.5 w-3.5" /> : <PlusIcon className="h-3.5 w-3.5" />}
        </button>
      </div>

      {creating && (
        <div className="mx-2 mb-1">
          <input
            autoFocus
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitCreate();
              if (e.key === 'Escape') closeCreate();
            }}
            placeholder="Folder name"
            aria-label="New folder name"
            className={inputCls}
          />
        </div>
      )}

      {folders.map((f) => {
        const active = f.id === activeId;
        if (renamingId === f.id) {
          return (
            <div key={f.id} className="mx-2 my-px">
              <input
                autoFocus
                value={renameDraft}
                disabled={busy}
                onChange={(e) => setRenameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitRename(f.id);
                  if (e.key === 'Escape') closeRename();
                }}
                onBlur={closeRename}
                aria-label={`Rename ${f.name}`}
                className={inputCls}
              />
            </div>
          );
        }
        const confirming = confirmDeleteId === f.id;
        const unread = f.unread != null && f.unread > 0 ? f.unread : null;
        return (
          <div
            key={f.id}
            className={cn(
              'group mx-2 my-px flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 transition-colors',
              active
                ? 'bg-surface-elevated text-primary'
                : 'text-secondary hover:bg-surface-overlay',
            )}
          >
            <button
              type="button"
              onClick={() => onSelect(f.id)}
              aria-current={active}
              className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
            >
              <FolderIcon
                className={cn('h-4 w-4 shrink-0', active ? 'text-accent' : 'text-tertiary')}
              />
              <span className="flex-1 truncate text-[13px]">{f.name}</span>
            </button>
            {confirming ? (
              <span className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => void submitDelete(f.id)}
                  disabled={busy}
                  className="rounded px-1 text-[11px] font-semibold text-danger hover:underline"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDeleteId(null)}
                  className="rounded px-1 text-[11px] text-tertiary hover:text-secondary"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <>
                {unread != null && (
                  <span className="shrink-0 rounded-full bg-accent/[0.14] px-1.5 py-px text-[11px] font-semibold text-accent mono group-hover:hidden">
                    {unread > 999 ? '999+' : unread}
                  </span>
                )}
                <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                  <button
                    type="button"
                    onClick={() => {
                      setRenamingId(f.id);
                      setRenameDraft(f.name);
                      setConfirmDeleteId(null);
                    }}
                    aria-label={`Rename ${f.name}`}
                    title="Rename"
                    className="grid h-[22px] w-[22px] place-items-center rounded-md text-tertiary transition-colors hover:bg-surface-overlay hover:text-secondary"
                  >
                    <PencilIcon className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(f.id)}
                    aria-label={`Delete ${f.name}`}
                    title="Delete"
                    className="grid h-[22px] w-[22px] place-items-center rounded-md text-tertiary transition-colors hover:bg-surface-overlay hover:text-danger"
                  >
                    <TrashIcon className="h-3.5 w-3.5" />
                  </button>
                </span>
              </>
            )}
          </div>
        );
      })}

      {!creating && folders.length === 0 && (
        <p className="mx-3.5 my-1 text-[12px] leading-5 text-tertiary">
          No folders yet — create one to file mail.
        </p>
      )}
      {error && <p className="mx-3.5 my-1 text-[11px] leading-4 text-danger">{error}</p>}
    </>
  );
}

function FoldersColumn({
  mailboxes,
  selectedId,
  onSelect,
  showAllInboxes,
  unreadByMailbox,
  totalUnread,
  folder,
  onSelectFolder,
  pendingCount,
  onManageSenders,
  onCollapse,
  foldersEnabled,
  customFolders,
  activeCustomFolderId,
  onSelectCustomFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
}: {
  mailboxes: MailboxPick[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  showAllInboxes: boolean;
  unreadByMailbox: Map<string, number> | null;
  totalUnread: number | null;
  folder: MailFolder;
  onSelectFolder: (folder: MailFolder) => void;
  pendingCount: number;
  onManageSenders: () => void;
  onCollapse: () => void;
  /** True only for a single selected sovereign (James) mailbox — gates the custom-folder UI. */
  foldersEnabled: boolean;
  customFolders: MailFolderView[];
  activeCustomFolderId: string | null;
  onSelectCustomFolder: (id: string) => void;
  onCreateFolder: (name: string) => Promise<FolderActionResult>;
  onRenameFolder: (id: string, name: string) => Promise<FolderActionResult>;
  onDeleteFolder: (id: string) => Promise<FolderActionResult>;
}) {
  return (
    <aside className="flex h-full w-[236px] flex-col overflow-y-auto border-r border-subtle bg-surface-raised">
      <div className="flex items-center justify-between px-3.5 pb-1.5 pt-3.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.09em] text-tertiary">
          Accounts
        </h3>
        <button
          type="button"
          onClick={onCollapse}
          aria-label="Collapse accounts & folders"
          title="Collapse"
          className="grid h-[22px] w-[22px] place-items-center rounded-md text-tertiary transition-colors hover:bg-surface-overlay hover:text-secondary"
        >
          <ChevronLeftIcon className="h-3.5 w-3.5" />
        </button>
      </div>

      {showAllInboxes && (
        <AccountButton
          active={selectedId === ALL_INBOXES}
          onClick={() => onSelect(ALL_INBOXES)}
          tag="gradient"
          name="All inboxes"
          sub={`${mailboxes.length} mailbox${mailboxes.length === 1 ? '' : 'es'}`}
          count={totalUnread}
        />
      )}
      {mailboxes.map((mb) => {
        const unread = unreadByMailbox?.get(mb.id) ?? null;
        return (
          <AccountButton
            key={mb.id}
            active={mb.id === selectedId}
            onClick={() => onSelect(mb.id)}
            tag={`hsl(${addressHue(mb.email_address.toLowerCase())} 70% 55%)`}
            name={mb.display_name?.trim() || mb.email_address}
            sub={mb.email_address}
            count={unread}
          />
        );
      })}
      {mailboxes.length === 0 && (
        <p className="px-4 py-3 text-[12px] leading-5 text-tertiary">
          No mailboxes yet. Provision one to start reading and sending.
        </p>
      )}

      <div className="mx-3.5 my-2 h-px bg-border-subtle" />

      <div className="px-3.5 pb-1.5 pt-1">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.09em] text-tertiary">
          Folders
        </h3>
      </div>
      {/* Needs approval — the human-in-the-loop queue (real pending count). */}
      <Link
        href="/agent-inbox"
        className="mx-2 my-px flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-secondary transition-colors hover:bg-surface-overlay"
      >
        <CheckSquareIcon className="h-4 w-4 shrink-0 text-tertiary" />
        <span className="flex-1 text-[13px]">Needs approval</span>
        {pendingCount > 0 && (
          <span className="rounded-full bg-warning/[0.14] px-1.5 py-px text-[11px] font-semibold text-warning mono">
            {pendingCount}
          </span>
        )}
      </Link>
      {FOLDERS.map((f) => {
        const Glyph = FOLDER_GLYPH[f.id];
        // A live custom folder owns the active highlight; de-select the system row.
        const active = f.id === folder && !activeCustomFolderId;
        return (
          <button
            key={f.id}
            type="button"
            onClick={() => onSelectFolder(f.id)}
            aria-current={active}
            className={cn(
              'mx-2 my-px flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors',
              active
                ? 'bg-surface-elevated text-primary'
                : 'text-secondary hover:bg-surface-overlay',
            )}
          >
            <Glyph className={cn('h-4 w-4 shrink-0', active ? 'text-accent' : 'text-tertiary')} />
            <span className="flex-1 text-[13px]">{f.label}</span>
          </button>
        );
      })}

      {foldersEnabled && (
        <>
          <div className="mx-3.5 my-2 h-px bg-border-subtle" />
          <CustomFoldersSection
            folders={customFolders}
            activeId={activeCustomFolderId}
            onSelect={onSelectCustomFolder}
            onCreate={onCreateFolder}
            onRename={onRenameFolder}
            onDelete={onDeleteFolder}
          />
        </>
      )}

      <div className="flex-1" />
      <div className="border-t border-subtle p-2">
        <button
          type="button"
          onClick={onManageSenders}
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] text-tertiary transition-colors hover:bg-surface-overlay hover:text-secondary"
        >
          <SlidersIcon className="h-4 w-4 shrink-0" />
          Blocked &amp; trusted senders
        </button>
        <Link
          href="/accounts"
          className="mt-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] text-tertiary transition-colors hover:bg-surface-overlay hover:text-secondary"
        >
          <MailIcon className="h-4 w-4 shrink-0" />
          Connect an account
        </Link>
      </div>
    </aside>
  );
}

function AccountButton({
  active,
  onClick,
  tag,
  name,
  sub,
  count,
}: {
  active: boolean;
  onClick: () => void;
  /** 'gradient' for All inboxes, else an hsl/color string. */
  tag: string;
  name: string;
  sub: string;
  count: number | null;
}) {
  const unread = count != null && count > 0;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active}
      className={cn(
        'mx-2 my-px flex items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left transition-colors',
        active ? 'bg-accent/[0.13] text-primary' : 'text-secondary hover:bg-surface-overlay',
      )}
    >
      <span
        className={cn('h-2 w-2 shrink-0 rounded-[3px]', active && 'ring-2 ring-accent/40')}
        style={{
          background:
            tag === 'gradient'
              ? 'linear-gradient(135deg,rgb(var(--accent)),rgb(var(--accent-2)))'
              : tag,
        }}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{name}</span>
        <span className="block truncate text-[11px] text-tertiary mono">{sub}</span>
      </span>
      <span
        className={cn(
          'shrink-0 text-[11px] font-semibold mono',
          unread ? 'text-accent' : 'text-tertiary',
        )}
      >
        {count == null ? '—' : count > 999 ? '999+' : count}
      </span>
    </button>
  );
}

/**
 * Collapsed form of the accounts+folders column: a slim 56px avatar rail so the
 * webmail never fully vanishes when the folder pane is shut. Mailbox avatars
 * (switch account) sit over a divider over the folder glyphs (switch folder) —
 * icon-only mirrors of FoldersColumn, each carrying its unread pip. The chevron
 * re-expands to the full 236px column.
 */
function FoldersRail({
  mailboxes,
  selectedId,
  onSelect,
  showAllInboxes,
  unreadByMailbox,
  totalUnread,
  folder,
  onSelectFolder,
  pendingCount,
  onExpand,
}: {
  mailboxes: MailboxPick[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  showAllInboxes: boolean;
  unreadByMailbox: Map<string, number> | null;
  totalUnread: number | null;
  folder: MailFolder;
  onSelectFolder: (folder: MailFolder) => void;
  pendingCount: number;
  onExpand: () => void;
}) {
  return (
    <aside className="flex h-full w-[56px] flex-col items-center gap-1 overflow-y-auto overflow-x-visible border-r border-subtle bg-surface-raised py-2.5">
      <button
        type="button"
        onClick={onExpand}
        aria-label="Expand accounts & folders"
        title="Expand accounts & folders"
        className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] text-tertiary transition-colors hover:bg-surface-overlay hover:text-secondary"
      >
        <ChevronRightIcon className="h-[18px] w-[18px]" />
      </button>

      {/* Accounts — one avatar per mailbox. */}
      {showAllInboxes && (
        <RailAvatar
          active={selectedId === ALL_INBOXES}
          onClick={() => onSelect(ALL_INBOXES)}
          gradient
          initial="∀"
          title="All inboxes"
          unread={totalUnread}
        />
      )}
      {mailboxes.map((mb) => {
        const name = mb.display_name?.trim() || mb.email_address;
        return (
          <RailAvatar
            key={mb.id}
            active={mb.id === selectedId}
            onClick={() => onSelect(mb.id)}
            hue={addressHue(mb.email_address.toLowerCase())}
            initial={(name.trim()[0] || '?').toUpperCase()}
            title={`${name} · ${mb.email_address}`}
            unread={unreadByMailbox?.get(mb.id) ?? null}
          />
        );
      })}

      <div className="my-1 h-px w-6 shrink-0 bg-border-subtle" />

      {/* Needs approval — the human-in-the-loop queue. */}
      <Link
        href="/agent-inbox"
        title="Needs approval"
        aria-label="Needs approval"
        className="relative grid h-9 w-9 shrink-0 place-items-center rounded-[9px] text-tertiary transition-colors hover:bg-surface-overlay hover:text-secondary"
      >
        <CheckSquareIcon className="h-[18px] w-[18px]" />
        {pendingCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-[15px] min-w-[15px] place-items-center rounded-lg border-2 border-surface-raised bg-warning px-[3px] text-[9px] font-bold leading-none text-white mono">
            {pendingCount > 99 ? '99+' : pendingCount}
          </span>
        )}
      </Link>

      {/* Folders — icon-only, active glyph filled. */}
      {FOLDERS.map((f) => {
        const Glyph = FOLDER_GLYPH[f.id];
        const active = f.id === folder;
        return (
          <button
            key={f.id}
            type="button"
            onClick={() => onSelectFolder(f.id)}
            aria-current={active}
            aria-label={f.label}
            title={f.label}
            className={cn(
              'grid h-9 w-9 shrink-0 place-items-center rounded-[9px] transition-colors',
              active
                ? 'bg-accent/[0.13] text-accent'
                : 'text-tertiary hover:bg-surface-overlay hover:text-secondary',
            )}
          >
            <Glyph className="h-[18px] w-[18px]" />
          </button>
        );
      })}
    </aside>
  );
}

function RailAvatar({
  active,
  onClick,
  hue,
  gradient,
  initial,
  title,
  unread,
}: {
  active: boolean;
  onClick: () => void;
  hue?: number;
  gradient?: boolean;
  initial: string;
  title: string;
  unread: number | null;
}) {
  const hasUnread = unread != null && unread > 0;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active}
      title={title}
      className="relative grid h-9 w-9 shrink-0 place-items-center"
    >
      <span
        className={cn(
          'grid h-[30px] w-[30px] place-items-center rounded-full text-[12px] font-semibold text-white transition-transform',
          active
            ? 'ring-2 ring-accent ring-offset-2 ring-offset-surface-raised'
            : 'opacity-90 hover:scale-105 hover:opacity-100',
        )}
        style={
          gradient
            ? { background: 'linear-gradient(135deg,rgb(var(--accent)),rgb(var(--accent-2)))' }
            : { background: `linear-gradient(140deg, hsl(${hue} 70% 56%), hsl(${hue} 62% 45%))` }
        }
      >
        {initial}
      </span>
      {hasUnread && (
        <span className="absolute right-0 top-0 grid h-[15px] min-w-[15px] place-items-center rounded-lg border-2 border-surface-raised bg-accent px-[3px] text-[9px] font-bold leading-none text-white mono">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  );
}

// ── (3) Conversation list ──────────────────────────────────────────────────────

type ListBanner = 'no-workspace' | 'error' | 'loading' | 'no-mailboxes' | 'no-space';

/** Bucket a message time into a scannable date group label (Today / Yesterday
 *  / This week / This month / "June 2026"). Threads arrive sorted newest-first,
 *  so emitting a header whenever the bucket changes chunks the list in order. */
function dateBucketKey(iso: string | null): string {
  if (!iso) return 'Earlier';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'Earlier';
  const d = new Date(t);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfThatDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfToday - startOfThatDay) / 86400000);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return 'This week';
  if (diffDays < 30) return 'This month';
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function ConversationList({
  banner,
  error,
  title,
  unreadCount,
  filter,
  onFilter,
  folder,
  spaceName,
  load,
  threads,
  selectedThreadId,
  onSelect,
  onRetry,
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
  draftForThread,
  selfAddresses,
  onQuickTriage,
  onQuickMark,
  onToggleFlag,
  onEmptyFolder,
}: {
  banner: ListBanner | null;
  error: string | null;
  title: string;
  unreadCount: number | null;
  filter: SegFilter;
  onFilter: (f: SegFilter) => void;
  folder: MailFolder;
  spaceName: string | null;
  load: Load;
  threads: ThreadView[];
  selectedThreadId: string | null;
  onSelect: (thread: ThreadView) => void;
  onRetry: () => void;
  unified: boolean;
  selectable: boolean;
  selected: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  cursorThreadId: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  rowRefs: RefObject<Map<string, HTMLButtonElement>>;
  draftForThread: (thread: ThreadView | null) => AgentInboxItemView | null;
  selfAddresses: ReadonlySet<string>;
  onQuickTriage: (id: string, disposition: 'ARCHIVE' | 'TRASH') => void;
  onQuickMark: (id: string, read: boolean) => void;
  onToggleFlag: (id: string, flagged: boolean) => void;
  onEmptyFolder?: () => void;
}) {
  const allChecked = threads.length > 0 && selected.size >= threads.length;
  const anySelected = selected.size > 0;

  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 z-[2] flex items-center justify-between gap-2 border-b border-subtle bg-surface-base/90 px-4 py-3 backdrop-blur">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
          {unreadCount != null && unreadCount > 0 && (
            <span className="shrink-0 text-[12px] text-tertiary">{unreadCount} unread</span>
          )}
        </div>
        <div className="flex shrink-0 gap-0.5 rounded-lg bg-surface-overlay p-0.5">
          {(['all', 'unread', 'starred', 'agent'] as SegFilter[]).map((seg) => (
            <button
              key={seg}
              type="button"
              onClick={() => onFilter(seg)}
              className={cn(
                'rounded-md px-2.5 py-1 text-[12px] font-medium capitalize transition-colors',
                filter === seg
                  ? 'bg-surface-raised text-primary shadow-token'
                  : 'text-tertiary hover:text-secondary',
              )}
            >
              {seg}
            </button>
          ))}
        </div>
      </div>
      {onEmptyFolder && (
        <div className="border-b border-subtle px-4 py-2">
          <Button variant="secondary" size="sm" onClick={onEmptyFolder}>
            Empty {folder === 'trash' ? 'Trash' : 'Spam'}
          </Button>
        </div>
      )}

      {selectable && threads.length > 0 && load === 'ready' && !banner && (
        <div
          className={cn(
            'flex items-center gap-2 border-b border-subtle px-4 py-1.5 transition-colors',
            anySelected && 'bg-surface-overlay/60',
          )}
        >
          <label className="inline-flex cursor-pointer select-none items-center gap-1.5">
            <input
              type="checkbox"
              ref={(el) => {
                if (el) el.indeterminate = anySelected && !allChecked;
              }}
              checked={allChecked}
              onChange={onToggleSelectAll}
              aria-label="Select all conversations in view"
              className="h-3.5 w-3.5 cursor-pointer accent-accent"
            />
            <span className={cn('text-[11px]', anySelected ? 'text-secondary' : 'text-tertiary')}>
              {anySelected ? `${selected.size} selected` : 'Select all'}
            </span>
          </label>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {banner ? (
          <ListBannerView banner={banner} error={error} spaceName={spaceName} onRetry={onRetry} />
        ) : load === 'loading' ? (
          <div className="space-y-px p-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <RowSkeleton key={i} />
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
          <EmptyList filter={filter} />
        ) : (
          <>
            {(() => {
              let prevBucket: string | null = null;
              return threads.map((t) => {
                const bucket = dateBucketKey(t.last_message_at);
                const showHeader = bucket !== prevBucket;
                prevBucket = bucket;
                return (
                  <Fragment key={t.id}>
                    {showHeader && (
                      <div className="sticky top-0 z-[1] border-b border-subtle bg-surface-base/85 px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-tertiary backdrop-blur">
                        {bucket}
                      </div>
                    )}
                    <ConversationRow
                      thread={t}
                      active={t.id === selectedThreadId}
                      cursor={t.id === cursorThreadId}
                      unified={unified}
                      selectable={selectable}
                      checked={selected.has(t.id)}
                      anySelected={selected.size > 0}
                      onToggle={() => onToggleSelect(t.id)}
                      onSelect={() => onSelect(t)}
                      draft={draftForThread(t)}
                      selfAddresses={selfAddresses}
                      onQuickTriage={onQuickTriage}
                      onQuickMark={onQuickMark}
                      onToggleFlag={onToggleFlag}
                      refCb={(el) => {
                        if (el) rowRefs.current?.set(t.id, el);
                        else rowRefs.current?.delete(t.id);
                      }}
                    />
                  </Fragment>
                );
              });
            })()}
            {hasMore && (
              <div className="p-2">
                <Button variant="secondary" size="sm" block disabled={loadingMore} onClick={onLoadMore}>
                  {loadingMore ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ConversationRow({
  thread,
  active,
  cursor,
  unified,
  selectable,
  checked,
  anySelected,
  onToggle,
  onSelect,
  draft,
  refCb,
  selfAddresses,
  onQuickTriage,
  onQuickMark,
  onToggleFlag,
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
  draft: AgentInboxItemView | null;
  refCb: (el: HTMLButtonElement | null) => void;
  selfAddresses: ReadonlySet<string>;
  onQuickTriage: (id: string, disposition: 'ARCHIVE' | 'TRASH') => void;
  onQuickMark: (id: string, read: boolean) => void;
  onToggleFlag: (id: string, flagged: boolean) => void;
}) {
  const when = useMemo(() => formatWhen(thread.last_message_at), [thread.last_message_at]);
  // The people who AREN'T you — the list should surface the other party, never
  // the account owner. Fall back to the raw list only for threads that are
  // entirely self (e.g. notes-to-self) so a row never renders empty.
  const others = useMemo(() => {
    const others = thread.participants.filter(
      (p) => !p.address || !selfAddresses.has(p.address.toLowerCase().trim()),
    );
    return others.length > 0 ? others : thread.participants;
  }, [thread.participants, selfAddresses]);
  const lead = others[0] ?? null;
  const who = useMemo(() => {
    const names = others.map((p) => p.name?.trim() || p.address).filter(Boolean);
    if (names.length === 0) return 'No participants';
    if (names.length <= 2) return names.join(', ');
    return `${names[0]} +${names.length - 1}`;
  }, [others]);

  return (
    <div
      className={cn(
        'group relative flex cursor-pointer items-start gap-2.5 border-b border-subtle px-3 py-2.5 transition-colors duration-fast ease-token',
        active ? 'bg-accent/[0.10]' : 'hover:bg-surface-overlay/60',
        cursor && 'ring-1 ring-inset ring-accent/50',
      )}
    >
      {/* Selection accent — animates in/out instead of snapping. */}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute left-0 top-0 bottom-0 w-[3px] origin-left rounded-r-[2px] bg-accent transition-[opacity,transform] duration-token ease-token',
          active ? 'scale-x-100 opacity-100' : 'scale-x-0 opacity-0',
        )}
      />
      {/* Unread rail — suppressed while active so it never stacks next to the
          selection accent bar as two adjacent violet strips. */}
      <span
        className={cn(
          'mt-0.5 w-1 shrink-0 self-stretch rounded-[3px]',
          thread.unread && !active ? 'bg-accent' : 'bg-transparent',
        )}
      />
      {selectable && (
        <span className="flex shrink-0 items-center pt-1" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggle}
            aria-label={`Select conversation: ${thread.subject?.trim() || '(no subject)'}`}
            className={cn(
              'h-3.5 w-3.5 cursor-pointer accent-accent transition-opacity',
              checked || anySelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 max-lg:opacity-100',
            )}
          />
        </span>
      )}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggleFlag(thread.id, !thread.flagged);
        }}
        aria-label={thread.flagged ? 'Unstar conversation' : 'Star conversation'}
        title={thread.flagged ? 'Unstar' : 'Star'}
        className={cn(
          'mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors',
          thread.flagged
            ? 'text-warning hover:bg-surface-overlay'
            : 'text-muted opacity-0 hover:bg-surface-overlay hover:text-secondary group-hover:opacity-100 focus:opacity-100 max-lg:opacity-100',
        )}
      >
        <StarIcon className={cn('h-4 w-4', thread.flagged && 'fill-current')} />
      </button>
      <span
        className={cn(
          'mt-0.5 grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full text-[12px] font-semibold text-white transition-opacity duration-token ease-token',
          thread.unread ? 'opacity-100' : 'opacity-[0.82]',
        )}
        style={avatarHueStyle(lead?.address || thread.id)}
        aria-hidden
      >
        {initials(lead?.name, lead?.address)}
      </span>
      <button
        type="button"
        ref={refCb}
        onClick={onSelect}
        aria-current={active}
        className="min-w-0 flex-1 text-left"
      >
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[13px]',
              thread.unread ? 'font-semibold text-primary' : 'font-medium text-secondary',
            )}
          >
            {who}
          </span>
          {when && (
            <span
              className={cn(
                'shrink-0 text-right text-[11px] tabular-nums mono transition-opacity group-hover:opacity-0',
                thread.unread ? 'font-medium text-secondary' : 'text-tertiary',
              )}
            >
              {when}
            </span>
          )}
        </span>
        {/* Subject sits one weight-step below the sender so the two lines don't
            both peak — sender is the loud anchor, subject the supporting line. */}
        <span
          className={cn(
            'mt-0.5 block truncate text-[13px]',
            thread.unread ? 'font-medium text-primary' : 'font-normal text-tertiary',
          )}
        >
          {thread.subject?.trim() || '(no subject)'}
        </span>
        {thread.last_snippet && (
          <span
            className={cn(
              'mt-0.5 block truncate text-[12px]',
              thread.unread ? 'text-tertiary' : 'text-muted',
            )}
          >
            {thread.last_snippet}
          </span>
        )}
        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {/* One chip for a staged draft — "draft ready" and "needs approval"
              are the same state, so showing both was redundant noise. */}
          {draft && <Chip tone="agent" icon="bot" label="Draft · needs approval" />}
          {unified && thread.mailbox_address && <AccountChip address={thread.mailbox_address} />}
          {thread.has_attachments && (
            <span className="inline-flex items-center text-tertiary" aria-label="Has attachment">
              <Paperclip className="h-3.5 w-3.5" />
            </span>
          )}
          {thread.message_count > 1 && (
            <span className="rounded bg-surface-overlay px-1.5 text-[10px] text-muted mono">
              {thread.message_count}
            </span>
          )}
        </span>
      </button>
      {/* Hover triage — sits over the timestamp slot so you can archive/trash/
          mark-read without opening the thread. Keyboard-reachable, hidden until
          hover/focus-within so it never adds resting clutter. */}
      <div className="pointer-events-none absolute right-2 top-2 flex items-center gap-0.5 rounded-lg border border-subtle bg-surface-raised/95 p-0.5 opacity-0 shadow-token backdrop-blur transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
        <RowAction label="Archive" onClick={() => onQuickTriage(thread.id, 'ARCHIVE')}>
          <ArchiveIcon className="h-4 w-4" />
        </RowAction>
        <RowAction label={thread.unread ? 'Mark read' : 'Mark unread'} onClick={() => onQuickMark(thread.id, thread.unread)}>
          <CheckSquareIcon className="h-4 w-4" />
        </RowAction>
        <RowAction label="Trash" danger onClick={() => onQuickTriage(thread.id, 'TRASH')}>
          <TrashIcon className="h-4 w-4" />
        </RowAction>
      </div>
    </div>
  );
}

/** Per-row hover action — appears on the right of a conversation row so you can
 *  triage without opening it. Stops propagation so it never selects the row. */
function RowAction({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'grid h-7 w-7 place-items-center rounded-md text-tertiary transition-colors hover:bg-surface-elevated',
        danger ? 'hover:text-danger' : 'hover:text-primary',
      )}
    >
      {children}
    </button>
  );
}

function Chip({
  tone,
  icon,
  label,
}: {
  tone: 'agent' | 'approve' | 'sent';
  icon?: 'bot' | 'alert' | 'check';
  label: string;
}) {
  const cls =
    tone === 'agent'
      ? 'text-accent bg-accent/[0.13]'
      : tone === 'approve'
        ? 'text-warning bg-warning/[0.14]'
        : 'text-success bg-success/[0.14]';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold',
        cls,
      )}
    >
      {icon === 'bot' && <RobotDot />}
      {icon === 'alert' && <AlertDot />}
      {icon === 'check' && <CheckSquareIcon className="h-[11px] w-[11px]" />}
      {label}
    </span>
  );
}

function RobotDot() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-[11px] w-[11px]">
      <rect x="4" y="7" width="16" height="12" rx="2.5" />
      <path d="M9 7V5a3 3 0 0 1 6 0v2" />
    </svg>
  );
}
function AlertDot() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-[11px] w-[11px]">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4M12 16h.01" />
    </svg>
  );
}
function Paperclip({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
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

function AccountChip({ address }: { address: string }) {
  const { resolved } = useTheme();
  const hue = addressHue(address.toLowerCase());
  const label = address.split('@')[0]?.slice(0, 12) || address.slice(0, 12);
  // Light theme sits on a near-white surface, where a 55%-lightness hue (yellow/
  // green/cyan especially) fails contrast — drop it to 40%. Dark theme keeps the
  // brighter 66% so the chip stays legible on the dark tint.
  const textL = resolved === 'light' ? 40 : 66;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold mono"
      style={{ backgroundColor: `hsl(${hue} 70% 50% / 0.16)`, color: `hsl(${hue} 70% ${textL}%)` }}
      title={address}
    >
      <span className="h-[7px] w-[7px] rounded-[2px]" style={{ background: `hsl(${hue} 70% 55%)` }} />
      {label}
    </span>
  );
}

function RowSkeleton() {
  return (
    <div className="flex gap-2.5 px-3 py-2.5">
      <div className="h-[34px] w-[34px] shrink-0 animate-pulse rounded-full bg-surface-overlay" />
      <div className="flex-1 space-y-1.5 py-0.5">
        <Skeleton w="45%" h={11} />
        <Skeleton w="80%" h={13} />
        <Skeleton w="65%" h={11} />
      </div>
    </div>
  );
}

function EmptyList({ filter }: { filter: SegFilter }) {
  const copy =
    filter === 'unread'
      ? { t: 'All caught up', d: 'No unread conversations in this view.' }
      : filter === 'starred'
        ? { t: 'No starred mail', d: 'Star conversations to keep them in this view.' }
      : filter === 'agent'
        ? { t: 'No agent drafts', d: 'When an agent stages a reply, it appears here with a violet Draft-ready tag.' }
        : { t: 'Nothing here', d: 'New mail appears here once the engine is connected.' };
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 px-6 py-16 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-2xl border border-subtle bg-surface-raised text-tertiary shadow-token">
        {filter === 'agent' ? (
          <RobotIcon className="h-5 w-5" />
        ) : filter === 'starred' ? (
          <StarIcon className="h-5 w-5" />
        ) : filter === 'unread' ? (
          <CheckSquareIcon className="h-5 w-5" />
        ) : (
          <MailIcon className="h-5 w-5" />
        )}
      </div>
      <p className="text-[13px] font-semibold text-primary">{copy.t}</p>
      <p className="max-w-[240px] text-[12px] leading-5 text-tertiary">{copy.d}</p>
    </div>
  );
}

function ListBannerView({
  banner,
  error,
  spaceName,
  onRetry,
}: {
  banner: ListBanner;
  error: string | null;
  spaceName: string | null;
  onRetry: () => void;
}) {
  const map: Record<ListBanner, { t: string; d: string }> = {
    'no-workspace': {
      t: 'No workspace yet',
      d: 'Your account isn’t a member of an Email-Ops workspace, so there are no mailboxes to show.',
    },
    error: { t: 'Could not load your mail', d: error ?? 'Unknown error.' },
    loading: { t: 'Loading…', d: 'Fetching your mailboxes.' },
    'no-mailboxes': {
      t: 'No mailboxes yet',
      d: 'Once a mailbox is provisioned for this workspace it shows up here.',
    },
    'no-space': {
      t: `No mailboxes in ${spaceName ?? 'this space'}`,
      d: 'This space doesn’t include any mailboxes yet. Switch back to “All”, or add some.',
    },
  };
  const copy = map[banner];
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <div className="grid h-11 w-11 place-items-center rounded-full bg-surface-overlay text-tertiary">
        <MailIcon className="h-5 w-5" />
      </div>
      <p className="text-sm font-medium text-primary">{copy.t}</p>
      <p className={cn('max-w-xs text-xs leading-5', banner === 'error' ? 'text-danger' : 'text-tertiary')}>
        {copy.d}
      </p>
      {banner === 'error' && (
        <Button variant="secondary" size="sm" className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

// ── (4) Reader ──────────────────────────────────────────────────────────────────

/**
 * A "Move to folder" control: a toolbar button that drops a menu of the
 * mailbox's custom folders. Renders nothing when there are no custom folders
 * (unified list, external mailbox, or none created) — so callers can place it
 * unconditionally and it self-hides. Closes on pick / outside-click / Escape.
 */
function MoveToFolderControl({
  folders,
  onPick,
  disabled,
}: {
  folders: MailFolderView[];
  onPick: (folderId: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  if (folders.length === 0) return null;
  return (
    <div ref={ref} className="relative">
      <ReaderTool
        label="Move to folder"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
      >
        <FolderIcon className="h-[17px] w-[17px]" />
      </ReaderTool>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 max-h-72 w-56 overflow-y-auto rounded-lg border border-subtle bg-surface-overlay p-1 shadow-xl">
          <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-tertiary">
            Move to folder
          </p>
          {folders.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                setOpen(false);
                onPick(f.id);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-secondary transition-colors hover:bg-surface-elevated hover:text-primary"
            >
              <FolderIcon className="h-4 w-4 shrink-0 text-tertiary" />
              <span className="flex-1 truncate">{f.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Reader({
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
  onMoveToFolder,
  customFolders,
  onReload,
  replySeed,
  replyRef,
  onSeedReply,
  onSeedReplyAll,
  onForward,
  onFocusReply,
  composerOpen,
  onCollapseComposer,
  onPopout,
  onToggleFlag,
  draft,
  draftAutonomyLabel,
  onApproveDraft,
  onDiscardDraft,
  onEditDraft,
  brief,
}: {
  workspaceId: string | null;
  mailbox: MailboxPick | null;
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
  /** Move the open thread into a custom folder (empty list => the control self-hides). */
  onMoveToFolder: (threadId: string, folderId: string) => Promise<TriageOutcome>;
  customFolders: MailFolderView[];
  /** Re-run the open thread's messages fetch (reader error-retry). */
  onReload: () => void;
  replySeed: ReplySeed;
  replyRef: RefObject<ReplyComposerHandle | null>;
  onSeedReply: (m: MessageView) => void;
  onSeedReplyAll: (m: MessageView) => void;
  onForward: (m: MessageView) => void;
  onFocusReply: () => void;
  composerOpen: boolean;
  onCollapseComposer: () => void;
  onPopout: () => void;
  onToggleFlag: (flagged: boolean) => void;
  draft: AgentInboxItemView | null;
  draftAutonomyLabel: string;
  onApproveDraft: () => Promise<{ ok: boolean; error?: string }>;
  onDiscardDraft: () => Promise<{ ok: boolean; error?: string }>;
  onEditDraft: () => void;
  brief: BriefData;
}) {
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

  // Reader identity: prefer the latest inbound message's sender, else lead participant.
  const sender = useMemo(() => {
    const self = mailbox?.email_address?.toLowerCase() ?? '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const f = messages[i].from;
      if (f?.address && f.address.toLowerCase() !== self) return f;
    }
    return messages[messages.length - 1]?.from ?? thread?.participants[0] ?? null;
  }, [messages, mailbox, thread]);
  const when = formatWhen(thread?.last_message_at ?? messages[messages.length - 1]?.sent_at ?? null);
  const lastMsg = messages[messages.length - 1] ?? null;

  const [triageBusy, setTriageBusy] = useState(false);
  const runTriage = async (d: 'INBOX' | 'ARCHIVE' | 'TRASH' | 'SPAM', opts?: { blockSender?: boolean }) => {
    if (!threadId || triageBusy) return;
    setTriageBusy(true);
    const res = await onTriage(threadId, d, opts);
    if (!res.ok) setTriageBusy(false);
  };

  if (!threadId) return <DailyBrief brief={brief} />;

  return (
    <div className="flex h-full flex-col bg-surface-raised">
      <div className="sticky top-0 z-[2] border-b border-subtle bg-surface-raised/[0.92] px-5 py-3.5 backdrop-blur sm:px-6">
        <div className="mb-3 flex items-center gap-2.5">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to conversations"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-tertiary hover:bg-surface-overlay hover:text-primary lg:hidden"
          >
            <ChevronLeftIcon className="h-[18px] w-[18px]" />
          </button>
          <h1 className="flex-1 text-[19px] font-bold leading-[1.3] tracking-[-0.015em] text-primary">
            {thread?.subject?.trim() || '(no subject)'}
          </h1>
          <div className="flex shrink-0 items-center gap-1">
            <ReaderTool
              label={thread?.flagged ? 'Unstar conversation' : 'Star conversation'}
              accent={!!thread?.flagged}
              onClick={() => onToggleFlag(!thread?.flagged)}
            >
              <StarIcon className={cn('h-[17px] w-[17px]', thread?.flagged && 'fill-current')} />
            </ReaderTool>
            {folder !== 'inbox' && (
              <ReaderTool label="Move to inbox" onClick={() => void runTriage('INBOX')} disabled={triageBusy}>
                <InboxTrayIcon className="h-[17px] w-[17px]" />
              </ReaderTool>
            )}
            {folder !== 'archive' && (
              <ReaderTool label="Archive" onClick={() => void runTriage('ARCHIVE')} disabled={triageBusy}>
                <ArchiveIcon className="h-[17px] w-[17px]" />
              </ReaderTool>
            )}
            {folder !== 'spam' && (
              <ReaderTool
                label="Report spam"
                danger
                onClick={() => void runTriage('SPAM')}
                disabled={triageBusy}
              >
                <BanIcon className="h-[17px] w-[17px]" />
              </ReaderTool>
            )}
            {folder !== 'trash' && (
              <ReaderTool label="Trash" danger onClick={() => void runTriage('TRASH')} disabled={triageBusy}>
                <TrashIcon className="h-[17px] w-[17px]" />
              </ReaderTool>
            )}
            <MoveToFolderControl
              folders={customFolders}
              disabled={triageBusy}
              onPick={(folderId) => {
                if (threadId) void onMoveToFolder(threadId, folderId);
              }}
            />
            {/* Divide destructive triage from safe compose actions. */}
            <span aria-hidden className="mx-0.5 h-5 w-px bg-border-subtle" />
            <ReaderTool label="Reply" onClick={onFocusReply}>
              <ReplyIcon className="h-[17px] w-[17px]" />
            </ReaderTool>
            <ReaderTool label="Pop out message" accent onClick={onPopout}>
              <PopOutIcon className="h-4 w-4" />
            </ReaderTool>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-[15px] font-semibold text-white"
            style={avatarHueStyle(sender?.address || threadId || 'x')}
            aria-hidden
          >
            {initials(sender?.name, sender?.address)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-semibold text-primary">
              {participantLabel(sender)}
            </span>
            {sender?.address && (
              <span className="block truncate text-[12px] text-tertiary mono">{sender.address}</span>
            )}
          </span>
          <span className="shrink-0 text-right text-[12px] text-tertiary mono">
            {when}
            {mailbox && (
              <>
                <br />
                <span className="text-muted">to {mailbox.email_address}</span>
              </>
            )}
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {draft && (
          <AgentDraftCard
            item={draft}
            autonomyLabel={draftAutonomyLabel}
            onApprove={onApproveDraft}
            onDiscard={onDiscardDraft}
            onEdit={onEditDraft}
          />
        )}

        {load === 'loading' ? (
          <div className="space-y-3 p-4 sm:px-6">
            <MessageSkeleton />
            <MessageSkeleton />
          </div>
        ) : load === 'error' ? (
          <div className="p-6">
            <p className="text-sm font-medium text-primary">Could not load this conversation.</p>
            <p className="mt-1 text-xs text-danger">{error ?? 'Unknown error.'}</p>
            <Button variant="secondary" size="sm" className="mt-3" onClick={onReload}>
              Try again
            </Button>
          </div>
        ) : messages.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-sm text-tertiary">
              No messages in this thread yet — they appear here once the mail engine is connected.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border-subtle px-4 pb-1 sm:px-6">
            {messages.map((m) =>
              workspaceId ? (
                <MessageItem
                  key={m.id}
                  message={m}
                  workspaceId={workspaceId}
                  mailboxId={mailbox?.id ?? null}
                  collapsed={!expanded.has(m.id)}
                  isLast={m.id === lastMsg?.id}
                  onToggle={() => toggleExpanded(m.id)}
                  onReply={onSeedReply}
                  onReplyAll={onSeedReplyAll}
                  onForward={onForward}
                />
              ) : null,
            )}
          </ul>
        )}

        {/* On-demand reply zone: docked tight under the last message. Collapsed it
            is a compact action bar (no empty void); Reply / Reply all expand the
            full composer inline, Forward opens the full dialog. */}
        {load !== 'error' && load !== 'loading' && (
          <div className="px-4 pb-5 pt-1 sm:px-6">
            {composerOpen ? (
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
                onCollapse={onCollapseComposer}
              />
            ) : (
              <ReplyActionBar
                hasMessage={!!lastMsg}
                onReply={onFocusReply}
                onReplyAll={() => lastMsg && onSeedReplyAll(lastMsg)}
                onForward={() => lastMsg && onForward(lastMsg)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ReplyActionBar({
  hasMessage,
  onReply,
  onReplyAll,
  onForward,
}: {
  /** Reply-all / Forward need a concrete message; plain Reply uses the thread default. */
  hasMessage: boolean;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
}) {
  return (
    <div className="eops-rise-in flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={onReply}
        className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-surface-raised px-3.5 text-[13px] font-semibold text-primary transition-colors duration-fast ease-token hover:border-accent/60 hover:bg-accent/[0.06] hover:text-accent active:bg-accent/[0.1]"
      >
        <ReplyIcon className="h-4 w-4" />
        Reply
      </button>
      <button
        type="button"
        disabled={!hasMessage}
        onClick={onReplyAll}
        className="inline-flex h-9 items-center rounded-lg px-3 text-[13px] font-medium text-tertiary transition-colors duration-fast ease-token hover:bg-surface-overlay hover:text-primary disabled:opacity-50"
      >
        Reply all
      </button>
      <button
        type="button"
        disabled={!hasMessage}
        onClick={onForward}
        className="inline-flex h-9 items-center rounded-lg px-3 text-[13px] font-medium text-tertiary transition-colors duration-fast ease-token hover:bg-surface-overlay hover:text-primary disabled:opacity-50"
      >
        Forward
      </button>
    </div>
  );
}

function ReaderTool({
  label,
  onClick,
  accent,
  danger,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  accent?: boolean;
  danger?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        'grid h-8 w-8 place-items-center rounded-lg text-tertiary transition-colors disabled:opacity-50',
        accent
          ? 'hover:bg-accent/12 hover:text-accent'
          : danger
            ? 'hover:bg-danger/10 hover:text-danger'
            : 'hover:bg-surface-overlay hover:text-primary',
      )}
    >
      {children}
    </button>
  );
}

function MessageSkeleton() {
  return (
    <div className="rounded-token border border-subtle bg-surface-base/50 p-3">
      <div className="flex items-center gap-2">
        <Skeleton w="30%" h={14} />
        <Skeleton w={56} h={16} className="ml-auto" />
      </div>
      <div className="mt-3 space-y-2">
        <Skeleton w="90%" h={12} />
        <Skeleton w="75%" h={12} />
      </div>
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-grid h-[18px] min-w-[18px] place-items-center rounded-[5px] border border-border bg-surface-overlay px-1 text-[10px] leading-none text-secondary mono">
      {children}
    </kbd>
  );
}

export interface BriefData {
  mailboxName: string;
  unread: number | null;
  pendingCount: number;
  agentsLive: number | null;
  mailboxCount: number;
  pending: AgentInboxItemView[];
  hasUnread: boolean;
  onStartTriage: () => void;
  onCompose: () => void;
  onReviewApprovals: () => void;
  onReviewItem: (item: AgentInboxItemView) => void;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function BriefStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | null;
  tone?: 'accent' | 'warn';
}) {
  return (
    <div className="flex-1 rounded-token border border-subtle bg-surface-base/50 px-3 py-2.5">
      <div
        className={cn(
          'text-[22px] font-bold leading-none tracking-[-0.02em] tabular-nums mono',
          tone === 'warn' && value ? 'text-warning' : 'text-primary',
        )}
      >
        {value ?? '—'}
      </div>
      <div className="mt-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-tertiary">
        {label}
      </div>
    </div>
  );
}

/** The reader pane when nothing is open — a daily brief that earns the app's
 *  largest surface: the day's counts, what agents are waiting on you to
 *  approve, and one-key ways to start working. All from data already in hand. */
function DailyBrief({ brief }: { brief: BriefData }) {
  return (
    <div className="hidden h-full flex-col overflow-y-auto p-8 lg:flex">
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-tertiary">
            {new Date().toLocaleDateString(undefined, {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
            })}
          </p>
          <h1 className="mt-1 text-[22px] font-bold tracking-[-0.02em] text-primary">
            {greeting()}
          </h1>
          <p className="mt-0.5 text-[13px] text-secondary">
            Here’s where <span className="text-primary">{brief.mailboxName}</span> stands.
          </p>
        </div>

        <div className="flex gap-2.5">
          <BriefStat label="Unread" value={brief.unread} />
          <BriefStat label="Needs approval" value={brief.pendingCount} tone="warn" />
          <BriefStat label="Agents live" value={brief.agentsLive} />
          <BriefStat label="Inboxes" value={brief.mailboxCount} />
        </div>

        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-tertiary">
            Waiting on you
          </p>
          {brief.pending.length === 0 ? (
            <div className="flex items-center gap-3 rounded-token border border-subtle bg-surface-base/50 px-4 py-3.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-success/15 text-success">
                <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" aria-hidden>
                  <path
                    d="M3.5 8.5l3 3 6-7"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <p className="text-[13px] text-secondary">
                All caught up — no drafts waiting for your approval.
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {brief.pending.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => brief.onReviewItem(it)}
                  className="group flex w-full items-center gap-3 rounded-token border border-subtle bg-surface-base/50 px-3 py-2.5 text-left transition-colors hover:border-accent/50 hover:bg-accent/[0.06]"
                >
                  <span
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white"
                    style={avatarHueStyle(it.drafted_by || it.id)}
                    aria-hidden
                  >
                    {initials(agentLabel(it.drafted_by), it.drafted_by)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-primary">
                        {it.subject?.trim() || '(no subject)'}
                      </span>
                      {it.created_at && (
                        <span className="shrink-0 text-[11px] tabular-nums text-tertiary mono">
                          {formatWhen(it.created_at)}
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block truncate text-[12px] text-tertiary">
                      {agentLabel(it.drafted_by)} drafted
                      {it.to_address ? ` → ${it.to_address}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100">
                    Review
                  </span>
                </button>
              ))}
              {brief.pendingCount > brief.pending.length && (
                <button
                  type="button"
                  onClick={brief.onReviewApprovals}
                  className="px-1 pt-1 text-[12px] font-medium text-accent hover:underline"
                >
                  +{brief.pendingCount - brief.pending.length} more in approvals →
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {brief.hasUnread && (
            <button
              type="button"
              onClick={brief.onStartTriage}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-4 text-[13px] font-semibold text-white transition-colors hover:bg-accent-hover"
            >
              Start triage
            </button>
          )}
          <button
            type="button"
            onClick={brief.onCompose}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-surface-base px-4 text-[13px] font-semibold text-secondary transition-colors hover:border-accent/60 hover:text-primary"
          >
            Compose
          </button>
          <button
            type="button"
            onClick={brief.onReviewApprovals}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-surface-base px-4 text-[13px] font-semibold text-secondary transition-colors hover:border-accent/60 hover:text-primary"
          >
            Review approvals
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-subtle pt-4 text-[11px] text-tertiary">
          <Kbd>J</Kbd>
          <Kbd>K</Kbd>
          <span className="text-muted">move</span>
          <span className="text-border-strong">·</span>
          <Kbd>↵</Kbd>
          <span className="text-muted">open</span>
          <span className="text-border-strong">·</span>
          <Kbd>C</Kbd>
          <span className="text-muted">compose</span>
          <span className="text-border-strong">·</span>
          <Kbd>⌘K</Kbd>
          <span className="text-muted">command menu</span>
        </div>
      </div>
    </div>
  );
}

// ── Small shared helpers ────────────────────────────────────────────────────────

function initials(name?: string | null, address?: string | null): string {
  const n = name?.trim();
  if (n) {
    const parts = n.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return n.slice(0, 2).toUpperCase();
  }
  const a = address?.trim();
  if (a) return a.slice(0, 2).toUpperCase();
  return '··';
}

function normSubject(subject: string | null): string {
  return (subject ?? '')
    .replace(/^(\s*(re|fwd|fw)\s*:\s*)+/i, '')
    .trim()
    .toLowerCase();
}

function autonomyBadgeFor(
  item: AgentInboxItemView,
  fleet: { key: string; autonomy_level: AutonomyLevel }[],
): string {
  const a = fleet.find((x) => x.key === item.drafted_by);
  return a ? AUTONOMY_BADGE[a.autonomy_level] : 'HELD FOR APPROVAL';
}

// ── Reply / forward prefill (preserved from the webmail wave) ─────────────────────

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

function deriveReplyDefaults(
  messages: MessageView[],
  thread: ThreadView | null,
  mailbox: MailboxPick | null,
): ReplySeed {
  const self = mailbox?.email_address?.toLowerCase() ?? '';
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
  if (!to && thread) {
    const other = thread.participants.find((p) => p.address && p.address.toLowerCase() !== self);
    to = other?.address ?? thread.participants[0]?.address ?? '';
  }
  if (!inReplyTo && messages.length > 0) inReplyTo = messages[messages.length - 1].id;

  const subject = deriveReSubject(thread?.subject ?? lastSubject(messages));
  return { to: to ? [to] : [], cc: [], subject, inReplyTo, nonce: 0 };
}

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

function buildForwardPrefill(m: MessageView, thread: ThreadView | null): ComposePrefill {
  const baseSubject = (m.subject ?? thread?.subject ?? '').trim();
  const subject = /^fwd:/i.test(baseSubject) ? baseSubject : `Fwd: ${baseSubject}`.trim();
  const fromLabel = m.from
    ? `${participantLabel(m.from)}${m.from.address ? ` <${m.from.address}>` : ''}`
    : 'Unknown';
  const lines: string[] = ['', '', '---------- Forwarded message ----------', `From: ${fromLabel}`];
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

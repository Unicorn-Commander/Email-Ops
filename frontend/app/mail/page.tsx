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
import { Tooltip } from '@/components/Tooltip';
import { HelpHintBar } from '@/components/mail/HelpHintBar';
import { useActiveSpace } from '@/components/ActiveSpaceProvider';
import { useUiCommands } from '@/components/UiCommandProvider';
import { useMailboxCollapsed, useRailCollapsed } from '@/state/uiCollapse';
import {
  mailFoldersPane,
  mailRailPane,
  mailThreadListPane,
  usePaneWidth,
} from '@/state/paneWidths';
import { ResizableEdge } from '@/components/ResizableEdge';
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
  type ComposeOutcome,
  type Load,
  type TriageOutcome,
  type UseMailClient,
} from '@/components/mail/useMailClient';
import { ReplyComposer, type ReplyComposerHandle } from '@/components/mail/ReplyComposer';
import { ComposeDialog, type ComposeDialogPrefill } from '@/components/mail/ComposeDialog';
import { SnoozedDialog, ScheduledDialog } from '@/components/mail/ScheduleViews';
import { WindowedThreadList } from '@/components/mail/WindowedThreadList';
import { schedulePresets as snoozePresets, formatScheduleWhen as formatSnoozeWhen } from '@/lib/scheduleTime';
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
  ClockIcon,
} from '@/components/mail/icons';
import type {
  BulkAction,
  ComposeBody,
  MailboxPick,
  MailFolder,
  MailFolderView,
  MessageView,
  ThreadView,
  UploadedBlob,
} from '@/lib/mailApi';
import { UndoSendBar, readUndoSeconds, type UndoEntry } from '@/components/mail/UndoSendBar';
import { useDesktopNotifications } from '@/components/mail/useDesktopNotifications';
import { MailSettingsDialog } from '@/components/mail/MailSettingsDialog';
import { RulesDialog } from '@/components/mail/RulesDialog';
import { cleanupReason, deriveCleanupTargets } from '@/lib/cleanupTargets';
import { ProposedReplies, isProposedReply } from '@/components/mail/ProposedReplies';
import { AiPulse, type AiPulseActivityLine } from '@/components/mail/AiPulse';
import { HowAiHelps, requestAiHelpCard } from '@/components/mail/HowAiHelps';
import { useAgentPulse } from '@/components/mail/useAgentPulse';

/** Funnel glyph for the Rules entries (matches the stroke language of icons.tsx). */
function FunnelIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} className={className} aria-hidden>
      <path d="M3 5h18l-7 8v5l-4 2v-7L3 5Z" strokeLinejoin="round" />
    </svg>
  );
}

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

/** One-line label for the undo-send bar: "To alice@acme.com — Quarterly numbers". */
function undoSummary(body: ComposeBody): string {
  const to = body.to_address || body.cc?.[0] || '';
  const subj = body.subject?.trim() || '(no subject)';
  return to ? `To ${to} — ${subj}` : subj;
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

/**
 * The 4-column desktop grid (folders · list · reader · rail) plus its three
 * drag-resizable edges. iconnav is a flex sibling. Collapsed, the folders pane
 * becomes a slim 56px avatar rail (never 0) so the webmail never fully
 * vanishes; expanded tracks take the user-resized, persisted widths; the list
 * keeps a minmax() so over-constrained viewports degrade exactly like the old
 * fixed layout; and the reader always flexes to fill.
 *
 * Isolated in its own component ON PURPOSE: width previews land here every
 * animation frame during a drag, and the pane contents arrive as STABLE element
 * props from MailPage — so React bails out of reconciling the (large) folder /
 * list / reader / rail subtrees and the drag stays smooth.
 */
function MailPanesGrid({
  foldersCollapsed,
  railCollapsed,
  threadOpen,
  folders,
  list,
  reader,
  rail,
}: {
  foldersCollapsed: boolean;
  railCollapsed: boolean;
  threadOpen: boolean;
  folders: ReactNode;
  list: ReactNode;
  reader: ReactNode;
  rail: ReactNode;
}) {
  // Persisted pane widths. Collapse always wins: the collapsed tracks keep
  // their fixed slim widths and expanding restores the stored width.
  // `threadListW === null` means the fluid fr-based default.
  const foldersW = usePaneWidth(mailFoldersPane) ?? 236;
  const threadListW = usePaneWidth(mailThreadListPane);
  const railW = usePaneWidth(mailRailPane) ?? 320;
  // While a handle is engaged the grid transition pauses so tracks follow the
  // pointer 1:1 instead of easing behind it.
  const [paneResizing, setPaneResizing] = useState(false);

  const gridCols = `${foldersCollapsed ? '56px' : `${foldersW}px`} ${
    threadListW === null ? 'minmax(300px,1.15fr)' : `minmax(300px,${threadListW}px)`
  } minmax(360px,1.9fr) ${railCollapsed ? '44px' : `${railW}px`}`;

  return (
    <div
      className={cn(
        'grid min-h-0 flex-1 grid-cols-1 lg:[grid-template-columns:var(--cols)]',
        !paneResizing && 'transition-[grid-template-columns] duration-token ease-token',
      )}
      style={{ '--cols': gridCols } as CSSProperties}
    >
      {/* (2) accounts + folders — hidden on mobile. Collapses to a slim
          avatar rail (never fully vanishes) instead of disappearing. */}
      <div className="overflow-hidden max-lg:hidden">{folders}</div>

      {/* (3) conversation list — the only left pane on mobile until a thread opens. */}
      <section
        className={cn(
          'relative flex min-w-0 flex-col overflow-hidden border-r border-subtle bg-surface-base',
          threadOpen && 'max-lg:hidden',
        )}
      >
        {/* Resizes the FOLDERS column (prev sibling): the folders pane scrolls
            under its own right edge, so its handle lives on this boundary's
            clean side. */}
        {!foldersCollapsed && (
          <ResizableEdge
            store={mailFoldersPane}
            edge="left"
            target="prev-sibling"
            label="Resize folders pane"
            onDraggingChange={setPaneResizing}
          />
        )}
        {list}
      </section>

      {/* (4) reader — the only pane shown on mobile when a thread is open. */}
      <section
        className={cn(
          'relative flex min-w-0 flex-col overflow-hidden border-l border-subtle',
          !threadOpen && 'max-lg:hidden',
        )}
      >
        {/* Resizes the CONVERSATION-LIST column (prev sibling); the reader
            itself always flexes to fill. */}
        <ResizableEdge
          store={mailThreadListPane}
          edge="left"
          target="prev-sibling"
          label="Resize conversation list"
          onDraggingChange={setPaneResizing}
        />
        {reader}
      </section>

      {/* (5) right agent-activity rail — desktop only. */}
      <div className="relative hidden overflow-hidden lg:block">
        {!railCollapsed && (
          <ResizableEdge
            store={mailRailPane}
            edge="left"
            target="parent"
            label="Resize agent activity rail"
            onDraggingChange={setPaneResizing}
          />
        )}
        {rail}
      </div>
    </div>
  );
}

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
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const [scheduledOpen, setScheduledOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [popoutOpen, setPopoutOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [undoEntry, setUndoEntry] = useState<UndoEntry | null>(null);
  const undoKeyRef = useRef(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
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
  // The AI-visibility split: proposed replies (EMAIL drafts) vs cleanup batches.
  const pendingReplies = useMemo(() => pendingItems.filter(isProposedReply), [pendingItems]);
  const pendingCleanups = useMemo(
    () => pendingItems.filter((i) => i.kind === 'CLEANUP'),
    [pendingItems],
  );
  const pulse = useAgentPulse();
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

  const runBulkMoveToFolder = useCallback(
    async (folderId: string): Promise<{ ok: boolean; error?: string }> => {
      const ids = [...selected];
      if (ids.length === 0) return { ok: false };
      const res = await mail.moveThreadsToFolder(ids, folderId);
      if (res.ok) setSelected(new Set());
      return { ok: res.ok, error: res.error };
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
    !composeOpen &&
      !sendersOpen &&
      !snoozedOpen &&
      !scheduledOpen &&
      !rulesOpen &&
      !settingsOpen &&
      !helpOpen &&
      !popoutOpen &&
      !paletteOpen,
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
  // Undo-send closures outlive renders — always call the LATEST reload (the one
  // captured at send time may point at a since-closed thread).
  const reloadOpenThreadRef = useRef(reloadOpenThread);
  reloadOpenThreadRef.current = reloadOpenThread;

  // A single selected sovereign (stalwart) mailbox is the context for snooze,
  // send-later, and their management views. Null in unified mode / external accounts;
  // gates the rail entries, the ⌘K entries, and the composer's "Send later".
  const sovereignMailbox =
    !mail.unified &&
    mail.selectedMailbox &&
    mail.selectedMailbox.provider !== 'gmail' &&
    mail.selectedMailbox.provider !== 'microsoft'
      ? mail.selectedMailbox
      : null;
  const canSchedule = !!sovereignMailbox;

  // ── Undo-send: on sovereign mailboxes a "send" becomes a scheduled send due in
  // a few seconds, recallable from the UndoSendBar. Everywhere the schedule lane
  // is unavailable (external accounts, unified mode, window set to 0, older
  // backend) it falls back to the immediate lane — undo never blocks a send. ──
  const restoreComposer = useCallback((body: ComposeBody) => {
    setComposeInitial({
      // to_address is the composer's comma-joined list — split it back so each
      // recipient restores as its own chip, not one giant chip.
      to: body.to_address
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      cc: body.cc,
      bcc: body.bcc,
      subject: body.subject,
      body: body.body,
      bodyHtml: body.body_html,
      draftId: body.draft_id ?? null,
      // The blob refs are what matter; size is unknown post-hoc (display-only).
      attachments: body.attachments?.map((a) => ({ ...a, size: 0 })),
      thread_id: body.in_reply_to_thread_id,
    });
    setComposeOpen(true);
  }, []);

  const {
    compose: mailCompose,
    reply: mailReply,
    scheduleSend: mailScheduleSend,
    cancelScheduledSend: mailCancelScheduled,
    getScheduledSendState: mailScheduledState,
    refresh: mailRefresh,
  } = mail;

  const sendWithUndo = useCallback(
    async (body: ComposeBody, mailboxId?: string): Promise<ComposeOutcome> => {
      const secs = readUndoSeconds();
      if (!canSchedule || secs <= 0) return mailCompose(body, mailboxId);
      const sendAt = new Date(Date.now() + secs * 1000);
      const res = await mailScheduleSend(body, sendAt, mailboxId);
      if (!res.ok || !res.id || !res.mailboxId) {
        // AMBIGUOUS failure (network drop mid-request): the schedule may have
        // committed server-side — an immediate-send fallback could double-send.
        // Surface it instead; the Scheduled view holds the truth.
        if (res.ok === false && res.ambiguous) {
          return {
            ok: false,
            error:
              "Couldn't confirm the send — check the Scheduled view before trying again.",
          };
        }
        // DEFINITE refusal (dormant/external/validation) — send the normal way.
        return mailCompose(body, mailboxId);
      }
      const sid = res.id;
      const smbx = res.mailboxId;
      setUndoEntry({
        key: ++undoKeyRef.current,
        summary: undoSummary(body),
        expiresAt: sendAt.getTime(),
        undo: async () => {
          let c = await mailCancelScheduled(sid, smbx);
          if (!c.ok) c = await mailCancelScheduled(sid, smbx); // one retry on transport error
          if (c.ok && c.cancelled) {
            restoreComposer(body);
            return 'restored';
          }
          return 'too-late'; // the worker already claimed/sent it — verify instead
        },
        sendNow: async () => {
          const c = await mailCancelScheduled(sid, smbx);
          if (!c.ok || !c.cancelled) return 'raced';
          // Send through the SAME mailbox the schedule targeted — the selection
          // may have moved since.
          const out = await mailCompose(body, smbx);
          // ok merely means recorded — only a non-failed status is a real send.
          return out.ok && out.message?.status !== 'failed' ? 'sent' : 'failed';
        },
        verify: async () => {
          const state = await mailScheduledState(sid, smbx);
          if (state === 'sent') {
            // The message left AFTER the list last refreshed — pull it in so a
            // scheduled reply shows up in its thread like an immediate one.
            void mailRefresh();
            reloadOpenThreadRef.current();
          }
          return state;
        },
        restore: () => restoreComposer(body),
      });
      return { ok: true };
    },
    [canSchedule, mailCompose, mailScheduleSend, mailCancelScheduled, mailScheduledState, mailRefresh, restoreComposer],
  );

  // Reply lane: thread the reply explicitly so the scheduled copy lands in its
  // conversation exactly like an immediate reply would.
  const replyViaUndo = useCallback(
    async (body: Omit<ComposeBody, 'in_reply_to_thread_id'>): Promise<ComposeOutcome> => {
      const row = openThreadRow;
      if (!row) return mailReply(body); // the hook resolves the open thread itself
      return sendWithUndo({ ...body, in_reply_to_thread_id: row.id }, row.mailbox_id ?? undefined);
    },
    [openThreadRow, mailReply, sendWithUndo],
  );

  // ── Desktop notifications: opt-in poll of ONE real mailbox (never the unified
  // sentinel) — in unified mode fall back to the first human mailbox. ──
  const notifMailbox = mail.unified
    ? mail.mailboxes.find((m) => m.owner_kind === 'HUMAN') ?? mail.mailboxes[0] ?? null
    : mail.selectedMailbox;
  const desktopNotifications = useDesktopNotifications({
    workspaceId: mail.workspace?.workspace_id ?? null,
    mailboxId: notifMailbox?.id ?? null,
    mailboxLabel: notifMailbox?.email_address,
    onOpenThread: (threadId) => selectThread(threadId, notifMailbox?.id),
  });
  const {
    supported: notificationsSupported,
    enabled: notificationsEnabled,
    permission: notificationsPermission,
    setEnabled: setNotificationsEnabled,
  } = desktopNotifications;

  // The Rules dialog is only meaningful on a sovereign mailbox. If that context
  // evaporates while (or after) it's open — mailbox switch, account refresh —
  // drop the latched open state so it can't pop back unexpectedly later.
  const rulesContextGone = !sovereignMailbox && rulesOpen;
  useEffect(() => {
    if (rulesContextGone) setRulesOpen(false);
  }, [rulesContextGone]);

  // ── ⌘K command palette actions (built from the real handlers) ───────────────
  const { selectFolder, customFolders: cmdCustomFolders, moveThreadToFolder: cmdMoveToFolder } = mail;
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
    if (canSchedule) {
      list.push(
        {
          id: 'view:snoozed',
          label: 'Snoozed',
          group: 'Actions',
          icon: <ClockIcon />,
          keywords: 'snoozed later remind hidden tucked away',
          run: () => setSnoozedOpen(true),
        },
        {
          id: 'view:scheduled',
          label: 'Scheduled',
          group: 'Actions',
          icon: <SendIcon />,
          keywords: 'scheduled send later outbox queued pending',
          run: () => setScheduledOpen(true),
        },
        {
          id: 'view:rules',
          label: 'Rules',
          group: 'Actions',
          icon: <FunnelIcon />,
          keywords: 'rules filters automation file sort auto-archive',
          run: () => setRulesOpen(true),
        },
      );
    }
    list.push({
      id: 'view:mail-settings',
      label: 'Mail settings',
      group: 'Actions',
      keywords: 'settings preferences notifications undo send window',
      run: () => setSettingsOpen(true),
    });
    list.push(
      {
        id: 'agent:proposed-replies',
        label: 'Review proposed replies',
        group: 'Actions',
        keywords: 'approve draft pending response ai agent replies',
        run: () => router.push('/agent-inbox'),
      },
      {
        id: 'agent:how-ai-helps',
        label: 'How your AI helps',
        group: 'Actions',
        keywords: 'tour orientation onboarding agents ai help explain',
        run: () => requestAiHelpCard(),
      },
    );
    if (notificationsSupported && notificationsPermission !== 'denied') {
      list.push({
        id: 'action:toggle-desktop-notifications',
        label: notificationsEnabled
          ? 'Disable desktop notifications'
          : 'Enable desktop notifications',
        group: 'Actions',
        keywords: 'notify alerts ping new mail desktop notifications',
        run: () => void setNotificationsEnabled(!notificationsEnabled),
      });
    }
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

    // Organize — file the open thread into a custom folder.
    if (selectedThreadId && cmdCustomFolders.length > 0) {
      for (const f of cmdCustomFolders) {
        list.push({
          id: `move:${f.id}`,
          label: `Move to ${f.name}`,
          group: 'Organize',
          icon: <FolderIcon />,
          keywords: `move file folder organize ${f.name}`,
          run: () => {
            void cmdMoveToFolder(selectedThreadId, f.id);
          },
        });
      }
    }

    // Help
    list.push(
      {
        id: 'help:shortcuts',
        label: 'Keyboard shortcuts',
        group: 'Help',
        hint: '?',
        keywords: 'help keyboard shortcuts keys cheatsheet',
        run: () => setHelpOpen(true),
      },
      {
        id: 'help:guide',
        label: 'Open the Help guide',
        group: 'Help',
        keywords: 'help guide manual docs documentation how to autonomy trust directions',
        run: () => router.push('/help'),
      },
    );

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
    cmdCustomFolders,
    cmdMoveToFolder,
    canSchedule,
    notificationsSupported,
    notificationsPermission,
    notificationsEnabled,
    setNotificationsEnabled,
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
    onAnalyzeInbox: () => router.push('/insights'),
    onReviewCleanup: () => router.push('/cleanup'),
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
    replies: pendingReplies.slice(0, 3),
    repliesTotal: pendingReplies.length,
    cleanups: pendingCleanups.slice(0, 3),
    pulseRecent: pulse.recent,
    paused: agentsPaused,
    onApproveItem: (it) => inbox.approve(it.id),
    onRejectItem: (it) => inbox.reject(it.id),
    onOpenRules: sovereignMailbox ? () => setRulesOpen(true) : undefined,
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

      {/* One-time orientation strip — localStorage-dismissed, quiet. */}
      <HelpHintBar />

      <div className="flex min-h-0 flex-1">
        <MailIconNav pendingCount={inbox.pendingCount} />

        <MailPanesGrid
          foldersCollapsed={foldersCollapsed}
          railCollapsed={railCollapsed}
          threadOpen={threadOpen}
          folders={
            foldersCollapsed ? (
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
                customFolders={mail.customFolders}
                activeCustomFolderId={mail.activeCustomFolderId}
                onSelectCustomFolder={mail.selectCustomFolder}
                schedulingEnabled={canSchedule}
                onOpenSnoozed={() => setSnoozedOpen(true)}
                onOpenScheduled={() => setScheduledOpen(true)}
                onOpenRules={() => setRulesOpen(true)}
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
                schedulingEnabled={canSchedule}
                onOpenSnoozed={() => setSnoozedOpen(true)}
                onOpenScheduled={() => setScheduledOpen(true)}
                onOpenRules={() => setRulesOpen(true)}
              />
            )
          }
          list={
            <ConversationList
              banner={banner}
              error={mail.threadsError ?? mail.error}
              title={listTitle}
              unreadCount={listUnread}
              filter={filter}
              onFilter={setFilter}
              searching={mail.query.trim().length > 0}
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
          }
          reader={
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
              onReply={replyViaUndo}
              onTriage={triageAndAdvance}
              onMoveToFolder={mail.moveThreadToFolder}
              customFolders={mail.customFolders}
              onSnooze={mail.snoozeThreadUntil}
              snoozeEnabled={
                // Sovereign James mailbox only — NOT gated on foldersSupported
                // (a different endpoint); a dormant snooze endpoint degrades clean.
                !mail.unified &&
                !!mail.selectedMailbox &&
                mail.selectedMailbox.provider !== 'gmail' &&
                mail.selectedMailbox.provider !== 'microsoft'
              }
              replyHasUndoWindow={canSchedule}
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
          }
          rail={
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
          }
        />
      </div>

      {/* Floating bulk bar (Wave-2 bulk endpoint; hidden when not deployed). */}
      {mail.features.bulk && (
        <BulkBar
          count={selected.size}
          folder={mail.folder}
          onAction={runBulk}
          onClear={() => setSelected(new Set())}
          customFolders={mail.customFolders}
          onMoveToFolder={runBulkMoveToFolder}
        />
      )}

      <ComposeDialog
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        fromAddress={mail.composeMailbox?.email_address ?? null}
        workspaceId={mail.workspace?.workspace_id ?? null}
        mailboxId={mail.composeMailbox?.id ?? null}
        onCompose={(b) =>
          sendWithUndo(
            composeInitial?.thread_id
              ? { ...b, in_reply_to_thread_id: composeInitial.thread_id }
              : b,
            mail.composeMailbox?.id,
          )
        }
        canSchedule={canSchedule}
        onScheduleSend={(b, at) =>
          mail.scheduleSend(
            // Keep the reply context on the explicit send-later lane too — a
            // scheduled reply must thread like an immediate one.
            composeInitial?.thread_id
              ? { ...b, in_reply_to_thread_id: composeInitial.thread_id }
              : b,
            at,
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

      <SnoozedDialog
        open={snoozedOpen}
        onClose={() => setSnoozedOpen(false)}
        workspaceId={mail.workspace?.workspace_id ?? null}
        mailbox={sovereignMailbox}
        onChanged={mail.refresh}
      />

      <ScheduledDialog
        open={scheduledOpen}
        onClose={() => setScheduledOpen(false)}
        workspaceId={mail.workspace?.workspace_id ?? null}
        mailbox={sovereignMailbox}
      />

      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} actions={commandActions} />

      <UndoSendBar
        entry={undoEntry}
        onDone={(k) => setUndoEntry((prev) => (prev?.key === k ? null : prev))}
        raised={selected.size > 0}
      />

      <MailSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        notifications={desktopNotifications}
      />

      <RulesDialog
        open={rulesOpen && !!sovereignMailbox}
        onClose={() => setRulesOpen(false)}
        workspaceId={mail.workspace?.workspace_id ?? ''}
        mailboxId={sovereignMailbox?.id ?? ''}
        mailboxLabel={
          sovereignMailbox?.display_name || sovereignMailbox?.email_address || 'this mailbox'
        }
        folders={mail.customFolders.map((f) => ({ id: f.id, name: f.name }))}
      />

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
        <Tooltip content={creating ? 'Cancel' : 'New folder — create a custom folder to file mail into'}>
          <button
            type="button"
            onClick={() => (creating ? closeCreate() : setCreating(true))}
            aria-label={creating ? 'Cancel new folder' : 'New folder'}
            className="grid h-[20px] w-[20px] place-items-center rounded-md text-tertiary transition-colors hover:bg-surface-overlay hover:text-secondary"
          >
            {creating ? <CloseIcon className="h-3.5 w-3.5" /> : <PlusIcon className="h-3.5 w-3.5" />}
          </button>
        </Tooltip>
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
                  <span className="shrink-0 rounded-full bg-accent/[0.14] px-1.5 py-px text-[11px] font-semibold text-accent mono group-hover:hidden group-focus-within:hidden">
                    {unread > 999 ? '999+' : unread}
                  </span>
                )}
                {/* focus-within parity so the actions are keyboard/SR reachable, not hover-only */}
                <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex group-focus-within:flex">
                  <Tooltip content="Rename folder">
                    <button
                      type="button"
                      onClick={() => {
                        setRenamingId(f.id);
                        setRenameDraft(f.name);
                        setConfirmDeleteId(null);
                      }}
                      aria-label={`Rename ${f.name}`}
                      className="grid h-[22px] w-[22px] place-items-center rounded-md text-tertiary transition-colors hover:bg-surface-overlay hover:text-secondary"
                    >
                      <PencilIcon className="h-3.5 w-3.5" />
                    </button>
                  </Tooltip>
                  <Tooltip content="Delete folder — mail it already filed stays where it is">
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(f.id)}
                      aria-label={`Delete ${f.name}`}
                      className="grid h-[22px] w-[22px] place-items-center rounded-md text-tertiary transition-colors hover:bg-surface-overlay hover:text-danger"
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </button>
                  </Tooltip>
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
  schedulingEnabled,
  onOpenSnoozed,
  onOpenScheduled,
  onOpenRules,
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
  /** Sovereign-mailbox only: gates the Snoozed / Scheduled / Rules entries. */
  schedulingEnabled: boolean;
  onOpenSnoozed: () => void;
  onOpenScheduled: () => void;
  onOpenRules: () => void;
}) {
  // w-full: the grid track (resizable, persisted) owns this pane's width.
  return (
    <aside className="flex h-full w-full flex-col overflow-y-auto border-r border-subtle bg-surface-raised">
      <div className="flex items-center justify-between px-3.5 pb-1.5 pt-3.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.09em] text-tertiary">
          Accounts
        </h3>
        <Tooltip content="Collapse this pane to a slim rail">
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Collapse accounts & folders"
            className="grid h-[22px] w-[22px] place-items-center rounded-md text-tertiary transition-colors hover:bg-surface-overlay hover:text-secondary"
          >
            <ChevronLeftIcon className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
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
      <Tooltip
        content="The approval queue — agent drafts and cleanup batches waiting on you"
        side="right"
      >
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
      </Tooltip>
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

      {/* Snoozed + Scheduled — action rows (open a manager), sovereign mailbox only. */}
      {schedulingEnabled && (
        <>
          <Tooltip content="Conversations hidden until later — wake or re-time them" side="right">
            <button
              type="button"
              onClick={onOpenSnoozed}
              className="mx-2 my-px flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-secondary transition-colors hover:bg-surface-overlay"
            >
              <ClockIcon className="h-4 w-4 shrink-0 text-tertiary" />
              <span className="flex-1 text-[13px]">Snoozed</span>
            </button>
          </Tooltip>
          <Tooltip content="Messages queued to send later — cancel any before they leave" side="right">
            <button
              type="button"
              onClick={onOpenScheduled}
              className="mx-2 my-px flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-secondary transition-colors hover:bg-surface-overlay"
            >
              <SendIcon className="h-4 w-4 shrink-0 text-tertiary" />
              <span className="flex-1 text-[13px]">Scheduled</span>
            </button>
          </Tooltip>
          <Tooltip
            content="Rules file mail as it arrives — conditions over sender/subject, actions like move or archive"
            side="right"
          >
            <button
              type="button"
              onClick={onOpenRules}
              className="mx-2 my-px flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-secondary transition-colors hover:bg-surface-overlay"
            >
              <FunnelIcon className="h-4 w-4 shrink-0 text-tertiary" />
              <span className="flex-1 text-[13px]">Rules</span>
            </button>
          </Tooltip>
        </>
      )}

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
  customFolders,
  activeCustomFolderId,
  onSelectCustomFolder,
  schedulingEnabled,
  onOpenSnoozed,
  onOpenScheduled,
  onOpenRules,
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
  customFolders: MailFolderView[];
  activeCustomFolderId: string | null;
  onSelectCustomFolder: (id: string) => void;
  schedulingEnabled: boolean;
  onOpenSnoozed: () => void;
  onOpenScheduled: () => void;
  onOpenRules: () => void;
}) {
  return (
    <aside className="flex h-full w-[56px] flex-col items-center gap-1 overflow-y-auto overflow-x-visible border-r border-subtle bg-surface-raised py-2.5">
      <Tooltip content="Expand the accounts & folders pane" side="right">
        <button
          type="button"
          onClick={onExpand}
          aria-label="Expand accounts & folders"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] text-tertiary transition-colors hover:bg-surface-overlay hover:text-secondary"
        >
          <ChevronRightIcon className="h-[18px] w-[18px]" />
        </button>
      </Tooltip>

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
      <Tooltip content="Needs approval — the queue of agent work waiting on you" side="right">
        <Link
          href="/agent-inbox"
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
      </Tooltip>

      {/* Folders — icon-only, active glyph filled. */}
      {FOLDERS.map((f) => {
        const Glyph = FOLDER_GLYPH[f.id];
        const active = f.id === folder && !activeCustomFolderId;
        return (
          <Tooltip key={f.id} content={f.label} side="right">
            <button
              type="button"
              onClick={() => onSelectFolder(f.id)}
              aria-current={active}
              aria-label={f.label}
              className={cn(
                'grid h-9 w-9 shrink-0 place-items-center rounded-[9px] transition-colors',
                active
                  ? 'bg-accent/[0.13] text-accent'
                  : 'text-tertiary hover:bg-surface-overlay hover:text-secondary',
              )}
            >
              <Glyph className="h-[18px] w-[18px]" />
            </button>
          </Tooltip>
        );
      })}

      {/* Snoozed + Scheduled — icon-only openers (sovereign mailbox only). */}
      {schedulingEnabled && (
        <>
          <Tooltip content="Snoozed — conversations hidden until later" side="right">
            <button
              type="button"
              onClick={onOpenSnoozed}
              aria-label="Snoozed"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] text-tertiary transition-colors hover:bg-surface-overlay hover:text-secondary"
            >
              <ClockIcon className="h-[18px] w-[18px]" />
            </button>
          </Tooltip>
          <Tooltip content="Scheduled — messages queued to send later" side="right">
            <button
              type="button"
              onClick={onOpenScheduled}
              aria-label="Scheduled"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] text-tertiary transition-colors hover:bg-surface-overlay hover:text-secondary"
            >
              <SendIcon className="h-[18px] w-[18px]" />
            </button>
          </Tooltip>
          <Tooltip content="Rules — file mail automatically as it arrives" side="right">
            <button
              type="button"
              onClick={onOpenRules}
              aria-label="Rules"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-[9px] text-tertiary transition-colors hover:bg-surface-overlay hover:text-secondary"
            >
              <FunnelIcon className="h-[18px] w-[18px]" />
            </button>
          </Tooltip>
        </>
      )}

      {/* Custom folders — icon-only mirror; human surface, neutral tokens. */}
      {customFolders.length > 0 && (
        <div className="my-1 h-px w-6 shrink-0 bg-border-subtle" />
      )}
      {customFolders.map((f) => {
        const active = f.id === activeCustomFolderId;
        return (
          <Tooltip key={f.id} content={f.name} side="right">
          <button
            type="button"
            onClick={() => onSelectCustomFolder(f.id)}
            aria-current={active}
            aria-label={f.name}
            className={cn(
              'relative grid h-9 w-9 shrink-0 place-items-center rounded-[9px] transition-colors',
              active
                ? 'bg-surface-overlay text-primary'
                : 'text-tertiary hover:bg-surface-overlay hover:text-secondary',
            )}
          >
            <FolderIcon className="h-[18px] w-[18px]" />
            {(f.unread ?? 0) > 0 && (
              <span className="absolute -right-0.5 -top-0.5 grid h-[15px] min-w-[15px] place-items-center rounded-lg border-2 border-surface-raised bg-tertiary px-[3px] text-[9px] font-bold leading-none text-white mono">
                {(f.unread ?? 0) > 99 ? '99+' : f.unread}
              </span>
            )}
          </button>
          </Tooltip>
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
    <Tooltip content={title} side="right">
    <button
      type="button"
      onClick={onClick}
      aria-current={active}
      aria-label={title}
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
    </Tooltip>
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
  searching,
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
  searching: boolean;
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
            <Tooltip
              key={seg}
              content={
                seg === 'all'
                  ? 'Show every conversation in this view'
                  : seg === 'unread'
                    ? 'Only unread conversations'
                    : seg === 'starred'
                      ? 'Only starred conversations'
                      : 'Only conversations with an agent draft waiting for your approval'
              }
            >
              <button
                type="button"
                onClick={() => onFilter(seg)}
                aria-pressed={filter === seg}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[12px] font-medium capitalize transition-colors',
                  filter === seg
                    ? 'bg-surface-raised text-primary shadow-token'
                    : 'text-tertiary hover:text-secondary',
                )}
              >
                {seg}
              </button>
            </Tooltip>
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
          <EmptyList filter={filter} searching={searching} />
        ) : (
          <>
            <WindowedThreadList
              items={threads}
              pinnedIds={[cursorThreadId, selectedThreadId]}
              bucketKey={(t) => dateBucketKey(t.last_message_at)}
              renderHeader={(bucket) => (
                <div className="sticky top-0 z-[1] border-b border-subtle bg-surface-base/85 px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-tertiary backdrop-blur">
                  {bucket}
                </div>
              )}
              renderRow={(t) => (
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
              )}
            />
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
      <Tooltip content={thread.flagged ? 'Unstar' : 'Star — keep this in the Starred filter'}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleFlag(thread.id, !thread.flagged);
          }}
          aria-label={thread.flagged ? 'Unstar conversation' : 'Star conversation'}
          className={cn(
            'mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors',
            thread.flagged
              ? 'text-warning hover:bg-surface-overlay'
              : 'text-muted opacity-0 hover:bg-surface-overlay hover:text-secondary group-hover:opacity-100 focus:opacity-100 max-lg:opacity-100',
          )}
        >
          <StarIcon className={cn('h-4 w-4', thread.flagged && 'fill-current')} />
        </button>
      </Tooltip>
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
            title={who}
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
          title={thread.subject?.trim() || undefined}
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
          {draft && (
            <Tooltip content="An agent staged a reply on this thread — open it to approve, edit, or discard. Nothing sends until you decide.">
              <span>
                <Chip tone="agent" icon="bot" label="Draft · needs approval" />
              </span>
            </Tooltip>
          )}
          {unified && thread.mailbox_address && <AccountChip address={thread.mailbox_address} />}
          {thread.has_attachments && (
            <Tooltip content="Has attachments">
              <span className="inline-flex items-center text-tertiary" aria-label="Has attachment">
                <Paperclip className="h-3.5 w-3.5" />
              </span>
            </Tooltip>
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
        <RowAction
          label="Archive"
          hint="Archive (e) — kept and searchable, out of the Inbox"
          onClick={() => onQuickTriage(thread.id, 'ARCHIVE')}
        >
          <ArchiveIcon className="h-4 w-4" />
        </RowAction>
        <RowAction
          label={thread.unread ? 'Mark read' : 'Mark unread'}
          onClick={() => onQuickMark(thread.id, thread.unread)}
        >
          <CheckSquareIcon className="h-4 w-4" />
        </RowAction>
        <RowAction
          label="Trash"
          hint="Move to Trash (#) — reversible until Trash is emptied"
          danger
          onClick={() => onQuickTriage(thread.id, 'TRASH')}
        >
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
  hint,
  onClick,
  danger,
  children,
}: {
  label: string;
  /** Richer tooltip line; falls back to the accessible label. */
  hint?: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip content={hint ?? label}>
      <button
        type="button"
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
    </Tooltip>
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

function EmptyList({ filter, searching }: { filter: SegFilter; searching: boolean }) {
  const copy = searching
    ? { t: 'No matches', d: 'No conversations match your search in this view. Try a different term or clear the search.' }
    : filter === 'unread'
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
      {filter === 'agent' && (
        <Link href="/help#agent-drafts" className="text-[12px] font-medium text-accent hover:underline">
          How agent drafts work →
        </Link>
      )}
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
        hint="Move to folder — file this conversation into one of your custom folders"
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

/** Snooze presets relative to now — only future times, terse labels. */
/**
 * Reader snooze menu — hide the open thread until a chosen time (the scheduler
 * restores it to Inbox then). Presets are shared with the composer's Send-later
 * (see lib/scheduleTime). Closes on pick / outside-click / Escape.
 */
function SnoozeControl({
  onSnooze,
  disabled,
}: {
  onSnooze: (until: Date) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusTrigger = () => ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        focusTrigger(); // return focus to the trigger, not lost to <body>
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    // Move focus into the menu so keyboard users land on the first option.
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const presets = useMemo(() => (open ? snoozePresets() : []), [open]);
  return (
    <div ref={ref} className="relative">
      <ReaderTool
        label="Snooze"
        hint="Snooze — hide this until a time you pick; it returns to the Inbox then"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
      >
        <ClockIcon className="h-[17px] w-[17px]" />
      </ReaderTool>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Snooze until"
          className="absolute right-0 top-full z-30 mt-1 w-60 rounded-lg border border-subtle bg-surface-overlay p-1 shadow-xl"
        >
          <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-tertiary">
            Snooze until
          </p>
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onSnooze(p.at);
              }}
              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-secondary transition-colors hover:bg-surface-elevated hover:text-primary focus:bg-surface-elevated focus:text-primary focus:outline-none"
            >
              <span>{p.label}</span>
              <span className="mono text-[11px] text-muted">{formatSnoozeWhen(p.at)}</span>
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
  onSnooze,
  snoozeEnabled,
  replyHasUndoWindow,
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
  /** Snooze the open thread out of the inbox until a chosen time. */
  onSnooze: (threadId: string, until: Date) => Promise<TriageOutcome>;
  /** Whether snooze is available for this mailbox (sovereign James, not external). */
  snoozeEnabled: boolean;
  /** Whether a reply from here gets an undo-send window (sovereign schedule lane).
   *  When false (external Gmail/M365 — immediate, irreversible), the composer asks
   *  a one-tap confirm before sending. Mirrors ComposeDialog's canSchedule. */
  replyHasUndoWindow: boolean;
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
  const runTriage = async (
    d: 'INBOX' | 'ARCHIVE' | 'TRASH' | 'SPAM',
    opts?: { blockSender?: boolean; trustSender?: boolean; senderAddress?: string },
  ) => {
    if (!threadId || triageBusy) return;
    setTriageBusy(true);
    // Always clear busy when the op settles — on success the reader advances to the
    // next thread and its buttons must be live again; on failure (or a throw) we stay
    // on this thread and must not be frozen. The guard above still blocks double-fire
    // while the await is in flight.
    try {
      await onTriage(threadId, d, opts);
    } finally {
      setTriageBusy(false);
    }
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
          <h1
            title={thread?.subject?.trim() || undefined}
            className="flex-1 text-[19px] font-bold leading-[1.3] tracking-[-0.015em] text-primary"
          >
            {thread?.subject?.trim() || '(no subject)'}
          </h1>
          <div className="flex shrink-0 items-center gap-1">
            <ReaderTool
              label={thread?.flagged ? 'Unstar conversation' : 'Star conversation'}
              hint={
                thread?.flagged
                  ? 'Unstar — remove from the Starred filter'
                  : 'Star — keep this in the Starred filter'
              }
              accent={!!thread?.flagged}
              onClick={() => onToggleFlag(!thread?.flagged)}
            >
              <StarIcon className={cn('h-[17px] w-[17px]', thread?.flagged && 'fill-current')} />
            </ReaderTool>
            {folder !== 'inbox' && (
              <ReaderTool
                label="Move to inbox"
                hint="Return this conversation to the Inbox"
                onClick={() => void runTriage('INBOX')}
                disabled={triageBusy}
              >
                <InboxTrayIcon className="h-[17px] w-[17px]" />
              </ReaderTool>
            )}
            {folder !== 'archive' && (
              <ReaderTool
                label="Archive"
                hint="Archive (e) — kept and searchable, out of the Inbox"
                onClick={() => void runTriage('ARCHIVE')}
                disabled={triageBusy}
              >
                <ArchiveIcon className="h-[17px] w-[17px]" />
              </ReaderTool>
            )}
            {folder !== 'spam' && (
              <ReaderTool
                label="Report spam"
                hint="Report spam — files it in Spam and blocks the sender"
                danger
                onClick={() =>
                  void runTriage('SPAM', {
                    blockSender: true,
                    ...(sender?.address ? { senderAddress: sender.address } : {}),
                  })
                }
                disabled={triageBusy}
              >
                <BanIcon className="h-[17px] w-[17px]" />
              </ReaderTool>
            )}
            {folder !== 'trash' && (
              <ReaderTool
                label="Trash"
                hint="Move to Trash (#) — reversible until Trash is emptied"
                danger
                onClick={() => void runTriage('TRASH')}
                disabled={triageBusy}
              >
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
            {snoozeEnabled && (
              <SnoozeControl
                disabled={triageBusy}
                onSnooze={(until) => {
                  if (threadId) void onSnooze(threadId, until);
                }}
              />
            )}
            {/* Divide destructive triage from safe compose actions. */}
            <span aria-hidden className="mx-0.5 h-5 w-px bg-border-subtle" />
            <ReaderTool label="Reply" hint="Reply to the latest message (r)" onClick={onFocusReply}>
              <ReplyIcon className="h-[17px] w-[17px]" />
            </ReaderTool>
            <ReaderTool
              label="Pop out message"
              hint="Pop out — read this in an overlay, or eject it to its own window"
              accent
              onClick={onPopout}
            >
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
                hasUndoWindow={replyHasUndoWindow}
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
  hint,
  onClick,
  accent,
  danger,
  disabled,
  children,
}: {
  label: string;
  /** Richer tooltip line; falls back to the accessible label. */
  hint?: string;
  onClick: () => void;
  accent?: boolean;
  danger?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip content={hint ?? label}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
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
    </Tooltip>
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
  onAnalyzeInbox: () => void;
  onReviewCleanup: () => void;
  onCompose: () => void;
  onReviewApprovals: () => void;
  onReviewItem: (item: AgentInboxItemView) => void;
  // ── AI-visibility layer (the "how is the AI helping me" answer) ──
  /** Pending EMAIL drafts (proposed replies), sliced for the brief. */
  replies: AgentInboxItemView[];
  repliesTotal: number;
  /** Pending CLEANUP batches, sliced — the "Waiting on you" list. */
  cleanups: AgentInboxItemView[];
  /** Recent agent activity lines ("Perry staged a reply · 2h ago"). */
  pulseRecent: AiPulseActivityLine[];
  /** The workspace agent kill-switch state (renders an honest Paused chip). */
  paused: boolean;
  onApproveItem: (item: AgentInboxItemView) => Promise<{ ok: boolean; error?: string }>;
  onRejectItem: (item: AgentInboxItemView) => Promise<{ ok: boolean; error?: string }>;
  /** Present only when a sovereign mailbox is selected (rules are sovereign-only). */
  onOpenRules?: () => void;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

/** One truthful line under a pending CLEANUP card: WHAT it touches (+ WHY). */
function PendingTargetLine({ item }: { item: AgentInboxItemView }) {
  if (item.kind !== 'CLEANUP') return null;
  const targets = deriveCleanupTargets(item.payload);
  const why = cleanupReason(item.payload);
  if (!targets && !why) return null;
  const first = targets?.rows?.[0];
  const label = first
    ? `${targets.verb}: ${
        (targets.scope === 'threads' ? first.subject : first.sender) || '(no subject)'
      }${targets.total > 1 ? ` +${targets.total - 1} more` : ''}`
    : targets
      ? `${targets.verb} ${targets.total} thread${targets.total === 1 ? '' : 's'}`
      : null;
  return (
    <span className="mt-0.5 block truncate text-[12px] text-tertiary">
      {label}
      {label && why ? ' · ' : ''}
      {why}
    </span>
  );
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

        <HowAiHelps
          onOpenRules={brief.onOpenRules}
          onOpenApprovals={brief.onReviewApprovals}
        />

        <div className="flex gap-2.5">
          <BriefStat label="Unread" value={brief.unread} />
          <BriefStat label="Needs approval" value={brief.pendingCount} tone="warn" />
          <BriefStat label="Agents live" value={brief.agentsLive} />
          <BriefStat label="Inboxes" value={brief.mailboxCount} />
        </div>

        <AiPulse
          agentsLive={brief.agentsLive}
          pendingDrafts={brief.repliesTotal}
          pendingCleanups={brief.pendingCount - brief.repliesTotal}
          rulesActive={null}
          lastAgentActivity={brief.pulseRecent}
          paused={brief.paused}
        />

        {brief.replies.length > 0 && (
          <ProposedReplies
            items={brief.replies}
            totalCount={brief.repliesTotal}
            onReview={brief.onReviewItem}
            onApprove={brief.onApproveItem}
            onReject={brief.onRejectItem}
            onViewAll={brief.onReviewApprovals}
          />
        )}

        {/* Cleanup batches only — proposed replies live in their own section above,
            so nothing double-lists. Hidden entirely when replies cover the queue. */}
        {(brief.cleanups.length > 0 || brief.pendingCount === 0) && (
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-tertiary">
            Waiting on you
          </p>
          {brief.pendingCount === 0 ? (
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
              {brief.cleanups.map((it) => (
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
                    <PendingTargetLine item={it} />
                  </span>
                  <span className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100">
                    Review
                  </span>
                </button>
              ))}
              {brief.pendingCount > brief.replies.length + brief.cleanups.length && (
                <button
                  type="button"
                  onClick={brief.onReviewApprovals}
                  className="px-1 pt-1 text-[12px] font-medium text-accent hover:underline"
                >
                  +{brief.pendingCount - brief.replies.length - brief.cleanups.length} more in
                  approvals →
                </button>
              )}
            </div>
          )}
        </div>
        )}

        <div className="flex flex-wrap gap-2">
          {brief.hasUnread && (
            <Tooltip content="Opens your first unread so you can sort it by hand — archive, snooze, or reply. For AI recommendations, use Analyze inbox.">
              <button
                type="button"
                onClick={brief.onStartTriage}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-4 text-[13px] font-semibold text-white transition-colors hover:bg-accent-hover"
              >
                Start triage
              </button>
            </Tooltip>
          )}
          <Tooltip content="AI reads your linked Gmail / Microsoft 365 inbox and recommends what to archive, unsubscribe, or clean up. Requires a connected account.">
            <button
              type="button"
              onClick={brief.onAnalyzeInbox}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-accent/40 bg-accent/[0.06] px-4 text-[13px] font-semibold text-accent transition-colors hover:bg-accent/10"
            >
              Analyze inbox
            </button>
          </Tooltip>
          <Tooltip content="Build a safe cleanup plan — protected mail is held back; safe mail can be trashed (reversible) or archived & purged, with undo.">
            <button
              type="button"
              onClick={brief.onReviewCleanup}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-border bg-surface-base px-4 text-[13px] font-semibold text-secondary transition-colors hover:border-accent/60 hover:text-primary"
            >
              Clean up
            </button>
          </Tooltip>
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

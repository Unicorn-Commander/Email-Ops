'use client';

/**
 * Data layer for the `/mail` client (the "retire Outlook" surface).
 *
 * Mirrors `useAgentInbox`: a `load` discriminator + `error` string + workspace
 * resolution via the active org (`useActiveWorkspace`), plus a 401 guard to login.
 * It coordinates the reads of a 3-pane mail client — the mailbox picker, the
 * selected mailbox's thread list (or the unified "All inboxes" aggregate), and
 * the selected thread's messages — each with its own independent load state so
 * a slow pane never blanks the others.
 *
 * Wave 2 adds: unified inbox, per-mailbox unread counts, full-text search,
 * offset paging, read/unread marking, and bulk triage. Every Wave-2 endpoint is
 * FEATURE-DETECTED: a 404/501 flips the matching `features.*` flag off and the
 * UI hides that affordance — no crashes, no error toasts.
 *
 * Degrade-clean: the mail engine is often DORMANT, so thread lists come back
 * EMPTY and a compose returns `status: 'failed'`. None of that is an error here;
 * empty is empty, and the truthful compose status is handed back to the caller.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, type MyWorkspace } from '@/lib/api';
import { useActiveWorkspace } from '@/components/ActiveWorkspaceProvider';
import {
  bulkThreadAction,
  composeMail,
  createMailFolder,
  deleteMailFolder,
  emptyMailFolder,
  getMailCounts,
  getMailThread,
  isMissingEndpoint,
  listAggregateThreads,
  listCustomFolderThreads,
  listMailFolders,
  listMailMailboxes,
  listMailThreads,
  moveThreadToCustomFolder,
  renameMailFolder,
  scheduleSend as apiScheduleSend,
  cancelScheduledSend as apiCancelScheduledSend,
  getScheduledSend as apiGetScheduledSend,
  snoozeThread,
  setThreadDisposition,
  setThreadFlags,
  setThreadRead,
  type BulkAction,
  type BulkActionResponse,
  type ComposeBody,
  type MailboxCounts,
  type MailboxPick,
  type MailFolder,
  type MailFolderView,
  type MessageComposeView,
  type MessageView,
  type ThreadDisposition,
  type ThreadView,
} from '@/lib/mailApi';

/** Sentinel mailbox id for the unified "All inboxes" list (Wave 2). */
export const ALL_INBOXES = '__all_inboxes__';

/** Page size for thread lists (also the load-more step). */
const PAGE_SIZE = 50;

/**
 * New-mail arrival poll cadence (ms). The poll is visibility-gated: the interval
 * only fetches while the tab is visible, and refetches immediately on focus /
 * visibilitychange so a user sitting on the inbox actually sees new mail land.
 */
const INBOX_POLL_MS = 30_000;

/** Three-state discriminator shared by every pane (suite pattern). */
export type Load = 'loading' | 'ready' | 'error';

/** Result of a compose/reply — carries the truthful backend `status`. */
export interface ComposeOutcome {
  ok: boolean;
  /** The recorded projection on success (inspect `.status`). */
  message?: MessageComposeView;
  error?: string;
}

/** Result of a triage (move-to-folder) action. */
export interface TriageOutcome {
  ok: boolean;
  error?: string;
}

/** Result of a bulk action. `unsupported` = endpoint missing (hide the UI). */
export interface BulkOutcome {
  ok: boolean;
  error?: string;
  unsupported?: boolean;
  result?: BulkActionResponse;
}

/** Optional sender side-effects to apply atomically with a triage. */
export interface TriageOpts {
  blockSender?: boolean;
  trustSender?: boolean;
  senderAddress?: string;
}

/** Which Wave-2 endpoints are live (start optimistic; 404/501 flips them off). */
export interface MailFeatures {
  aggregate: boolean;
  counts: boolean;
  read: boolean;
  bulk: boolean;
}

export interface UseMailClient {
  /** The workspace the client is scoped to (null = caller has no membership). */
  workspace: MyWorkspace | null;
  /** Top-level load: workspace + the mailbox list. */
  load: Load;
  error: string | null;

  /** Wave-2 feature availability (drives which affordances render). */
  features: MailFeatures;

  /** The pickable mailboxes (inbox picker). */
  mailboxes: MailboxPick[];
  /** The currently selected mailbox (null until the list resolves, or in unified mode). */
  selectedMailbox: MailboxPick | null;
  /** True when the unified "All inboxes" list is active. */
  unified: boolean;
  /** Select a mailbox by id — or `ALL_INBOXES` for the unified list. */
  selectMailbox: (mailboxId: string) => void;
  /** The mailbox a new compose sends from (first mailbox in unified mode). */
  composeMailbox: MailboxPick | null;

  /** Per-mailbox inbox counts (null until loaded / when the endpoint is missing). */
  counts: MailboxCounts[] | null;
  refreshCounts: () => void;

  /** The folder the thread list is scoped to (defaults to inbox). */
  folder: MailFolder;
  /** Switch folders — closes any open thread and refetches the list. */
  selectFolder: (folder: MailFolder) => void;

  /** The active full-text search query ('' = no search). */
  query: string;
  /** Set the (already debounced) search query — refetches the list. */
  setQuery: (q: string) => void;

  /** Thread list for the selected mailbox + its own load state. */
  threads: ThreadView[];
  threadsLoad: Load;
  threadsError: string | null;
  refreshThreads: () => void;
  /**
   * Silently refetch the current list + unread counts (the manual Refresh
   * button). Never blanks the list or trips the error state; `refreshing`
   * drives the button's spinner while it's in flight.
   */
  refresh: () => void;
  refreshing: boolean;
  /** Offset paging: whether another page may exist, and the loader. */
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;

  /** The selected thread id (null = none open). */
  selectedThreadId: string | null;
  /** The mailbox the open thread belongs to (matters in unified mode). */
  selectedThreadMailboxId: string | null;
  /**
   * Open (or close, with null) a thread. In unified mode pass the row's
   * `mailbox_id` so messages/replies route to the right mailbox. Opening an
   * unread thread optimistically clears the dot and fires the read endpoint.
   */
  selectThread: (threadId: string | null, mailboxId?: string) => void;
  /** Messages of the open thread + its own load state. */
  messages: MessageView[];
  messagesLoad: Load;
  messagesError: string | null;

  /** Mark threads read/unread (optimistic; uses the Wave-2 read endpoint). */
  markRead: (threadIds: string[], read: boolean) => void;
  /** Star/unstar threads (optimistic; maps to IMAP \Flagged). */
  toggleFlag: (threadId: string, flagged: boolean) => void;

  /**
   * Compose a new message. Sends from `mailboxId` when given (keeps uploads and
   * sends on the same mailbox), else the reply thread's mailbox / the selected
   * mailbox / the first one. Refreshes threads on success.
   */
  compose: (body: ComposeBody, mailboxId?: string) => Promise<ComposeOutcome>;
  /** Reply within the open thread (prefills handled by the caller). */
  reply: (body: Omit<ComposeBody, 'in_reply_to_thread_id'>) => Promise<ComposeOutcome>;

  /**
   * Move a thread to a folder (optionally block/trust the sender in the same
   * call). Refreshes the list and closes the thread if it was open.
   */
  triage: (
    threadId: string,
    disposition: ThreadDisposition,
    opts?: TriageOpts,
  ) => Promise<TriageOutcome>;

  /** Apply one action to many threads (Wave 2 bulk endpoint), optimistically. */
  bulk: (threadIds: string[], action: BulkAction) => Promise<BulkOutcome>;
  /** Permanently empty Trash/Spam for the selected mailbox after UI confirmation. */
  emptyFolder: (folder: 'trash' | 'spam') => Promise<TriageOutcome>;

  // ── Custom folders / labels (Wave 3) ───────────────────────────────────────
  /**
   * Whether the folders feature is deployed (a 404/501 from the folders route
   * flips this off and the rail hides — like the Wave-2 feature flags).
   */
  foldersSupported: boolean;
  /**
   * The selected sovereign mailbox's CUSTOM folders (role === null). Empty for
   * the unified list, external (gmail/microsoft) mailboxes, or a dormant engine.
   */
  customFolders: MailFolderView[];
  /** The custom folder whose threads the list is showing (null = a system folder). */
  activeCustomFolderId: string | null;
  /** The resolved active custom folder (null when a system folder is shown). */
  activeCustomFolder: MailFolderView | null;
  /** Show a custom folder's threads (swaps the list source; closes any open thread). */
  selectCustomFolder: (folderId: string) => void;
  /** Create a custom folder on the selected sovereign mailbox, then refresh the rail. */
  createFolder: (name: string) => Promise<TriageOutcome>;
  /** Rename a custom folder (optimistic; rolls back + reports on updated:false). */
  renameFolder: (folderId: string, name: string) => Promise<TriageOutcome>;
  /** Delete a custom folder (never a system/role folder; rolls back on deleted:false). */
  deleteFolder: (folderId: string) => Promise<TriageOutcome>;
  /**
   * Move a thread INTO a custom folder (optimistic removal from the current list;
   * truthful rollback + error on moved:false so nothing fakes success).
   */
  moveThreadToFolder: (threadId: string, folderId: string) => Promise<TriageOutcome>;
  /** Move a whole check-selection into a custom folder (per-thread, reconciled). */
  moveThreadsToFolder: (threadIds: string[], folderId: string) => Promise<TriageOutcome>;
  /** Snooze a thread out of the inbox until a chosen time (sovereign mailboxes only). */
  snoozeThreadUntil: (threadId: string, until: Date) => Promise<TriageOutcome>;
  /** Schedule the composed message to leave at a future time (sovereign mailboxes only).
   *  On success carries the scheduled item's id + resolved mailbox so the caller
   *  (send-later UI, undo-send bar) can cancel or verify it. */
  scheduleSend: (
    body: Pick<
      ComposeBody,
      | 'to_address'
      | 'subject'
      | 'body'
      | 'body_html'
      | 'cc'
      | 'bcc'
      | 'attachments'
      | 'draft_id'
      | 'in_reply_to_thread_id'
      | 'in_reply_to'
      | 'references'
    >,
    sendAt: Date,
    mailboxId?: string,
  ) => Promise<TriageOutcome & { id?: string; mailboxId?: string; ambiguous?: boolean }>;
  /** Cancel a pending scheduled send. `cancelled:false` = it already left (or was cancelled). */
  cancelScheduledSend: (
    id: string,
    mailboxId: string,
  ) => Promise<TriageOutcome & { cancelled?: boolean }>;
  /** Truthful post-window verdict for the undo-send bar. Null = unknown — give up quietly. */
  getScheduledSendState: (
    id: string,
    mailboxId: string,
  ) => Promise<'pending' | 'claimed' | 'sent' | 'cancelled' | 'failed' | null>;
}

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export function useMailClient(): UseMailClient {
  const router = useRouter();

  const [workspace, setWorkspace] = useState<MyWorkspace | null>(null);
  const [load, setLoad] = useState<Load>('loading');
  const [error, setError] = useState<string | null>(null);

  const [features, setFeatures] = useState<MailFeatures>({
    aggregate: true,
    counts: true,
    read: true,
    bulk: true,
  });
  const featuresRef = useRef(features);
  featuresRef.current = features;
  const disableFeature = useCallback((key: keyof MailFeatures) => {
    setFeatures((f) => (f[key] ? { ...f, [key]: false } : f));
  }, []);

  const [mailboxes, setMailboxes] = useState<MailboxPick[]>([]);
  const [selectedMailboxId, setSelectedMailboxId] = useState<string | null>(null);
  const [folder, setFolder] = useState<MailFolder>('inbox');
  const [query, setQueryState] = useState('');

  // Custom folders (Wave 3): the sovereign mailbox's role-null folders, plus the
  // active one (when the list is showing a custom folder rather than a system one).
  const [customFolders, setCustomFolders] = useState<MailFolderView[]>([]);
  const [activeCustomFolderId, setActiveCustomFolderId] = useState<string | null>(null);
  const [foldersSupported, setFoldersSupported] = useState(true);

  const [threads, setThreads] = useState<ThreadView[]>([]);
  const [threadsLoad, setThreadsLoad] = useState<Load>('loading');
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [counts, setCounts] = useState<MailboxCounts[] | null>(null);

  const [openThread, setOpenThread] = useState<{ id: string; mailboxId: string | null } | null>(
    null,
  );
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [messagesLoad, setMessagesLoad] = useState<Load>('loading');
  const [messagesError, setMessagesError] = useState<string | null>(null);

  // Guards stale async writes when the selection changes mid-flight.
  const threadReqRef = useRef(0);
  const messageReqRef = useRef(0);

  // Refs so stable callbacks can read current state without re-creating.
  const mailboxesRef = useRef(mailboxes);
  mailboxesRef.current = mailboxes;
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const openThreadRef = useRef(openThread);
  openThreadRef.current = openThread;
  const selectedMailboxIdRef = useRef(selectedMailboxId);
  selectedMailboxIdRef.current = selectedMailboxId;
  const folderRef = useRef(folder);
  folderRef.current = folder;
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const queryRef = useRef(query);
  queryRef.current = query;
  // Custom-folder refs so the thread fetch + stable callbacks read the live view.
  const activeCustomFolderIdRef = useRef(activeCustomFolderId);
  activeCustomFolderIdRef.current = activeCustomFolderId;
  const customFoldersRef = useRef(customFolders);
  customFoldersRef.current = customFolders;
  const foldersSupportedRef = useRef(foldersSupported);
  foldersSupportedRef.current = foldersSupported;
  // Read the current in-flight/list state from the poll without re-arming it.
  const threadsLoadRef = useRef(threadsLoad);
  threadsLoadRef.current = threadsLoad;
  const loadingMoreRef = useRef(loadingMore);
  loadingMoreRef.current = loadingMore;

  // A 401 anywhere means the session lapsed — bounce to login (suite pattern).
  const guard401 = useCallback(
    (err: unknown): boolean => {
      if (err instanceof ApiError && err.status === 401) {
        router.replace('/auth/login');
        return true;
      }
      return false;
    },
    [router],
  );

  // Consume the active org (`ActiveWorkspaceProvider`) so the mail client
  // re-scopes when it switches; keyed on the workspace id to avoid refetch churn.
  const { activeWorkspace, load: workspaceLoad } = useActiveWorkspace();
  const activeWorkspaceId = activeWorkspace?.workspace_id ?? null;

  useEffect(() => {
    if (!activeWorkspace) {
      setWorkspace(null);
      setMailboxes([]);
      setSelectedMailboxId(null);
      setCounts(null);
      // Settle only once the org layer resolved (no membership → no mailboxes).
      if (workspaceLoad !== 'loading') setLoad('ready');
      return;
    }
    setWorkspace(activeWorkspace);
    let alive = true;
    setLoad('loading');
    void (async () => {
      try {
        const res = await listMailMailboxes(activeWorkspace.workspace_id);
        if (!alive) return;
        setMailboxes(res.items);
        // Default to the first mailbox (matches the prompt's spec).
        setSelectedMailboxId(res.items[0]?.id ?? null);
        setError(null);
        setLoad('ready');
      } catch (err) {
        if (!alive) return;
        if (guard401(err)) return;
        setError(messageOf(err, 'Could not load your mailboxes.'));
        setLoad('error');
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId, workspaceLoad, guard401]);

  // ── Counts (Wave 2, feature-detected) ─────────────────────────────────────
  const refreshCounts = useCallback(() => {
    const ws = workspaceRef.current;
    if (!ws || !featuresRef.current.counts) return;
    void (async () => {
      try {
        const res = await getMailCounts(ws.workspace_id);
        setCounts(res.mailboxes ?? []);
      } catch (err) {
        if (guard401(err)) return;
        if (isMissingEndpoint(err)) {
          disableFeature('counts');
          setCounts(null);
        }
        // Any other failure: keep whatever counts we had — never toast on this.
      }
    })();
  }, [guard401, disableFeature]);

  useEffect(() => {
    if (workspace) refreshCounts();
  }, [workspace, refreshCounts]);

  /** Optimistically bump a mailbox's inbox_unread by delta (clamped ≥ 0). */
  const bumpUnread = useCallback((mailboxId: string | null, delta: number) => {
    if (!mailboxId || mailboxId === ALL_INBOXES) return;
    setCounts((prev) =>
      prev
        ? prev.map((c) =>
            c.mailbox_id === mailboxId
              ? { ...c, inbox_unread: Math.max(0, c.inbox_unread + delta) }
              : c,
          )
        : prev,
    );
  }, []);

  // ── Thread list (single mailbox or aggregate; search + offset paging) ─────
  const fetchThreads = useCallback(
    async (
      ws: MyWorkspace,
      mailboxId: string,
      f: MailFolder,
      q: string,
      offset: number,
      append: boolean,
      // Silent = background poll / manual Refresh: keep the current list visible
      // (no skeleton) and never surface a transient failure as an error state.
      silent = false,
    ) => {
      const req = ++threadReqRef.current;
      if (append) {
        setLoadingMore(true);
      } else {
        if (!silent) setThreadsLoad('loading');
        setLoadingMore(false); // a fresh list supersedes any in-flight load-more
      }
      try {
        const opts = { folder: f, limit: PAGE_SIZE, q: q || undefined, offset: offset || undefined };
        // A live custom folder overrides the system folder as the list source.
        const customId = activeCustomFolderIdRef.current;
        const res =
          mailboxId === ALL_INBOXES
            ? await listAggregateThreads(ws.workspace_id, opts)
            : customId
              ? await listCustomFolderThreads(ws.workspace_id, mailboxId, customId, {
                  limit: PAGE_SIZE,
                  q: q || undefined,
                  offset: offset || undefined,
                })
              : await listMailThreads(ws.workspace_id, mailboxId, opts);
        if (req !== threadReqRef.current) return; // superseded
        setThreads((prev) => {
          if (!append) return res.threads;
          const seen = new Set(prev.map((t) => t.id));
          return [...prev, ...res.threads.filter((t) => !seen.has(t.id))];
        });
        setHasMore(res.threads.length >= PAGE_SIZE);
        setThreadsError(null);
        setThreadsLoad('ready');
      } catch (err) {
        if (req !== threadReqRef.current) return;
        if (guard401(err)) return;
        if (mailboxId === ALL_INBOXES && isMissingEndpoint(err)) {
          // Aggregate not deployed — hide "All inboxes" and fall back gracefully.
          disableFeature('aggregate');
          setSelectedMailboxId(mailboxesRef.current[0]?.id ?? null);
          return;
        }
        // A background/manual refresh must never blow a working list into an
        // error state on a transient failure — keep what we have; the next tick
        // (or the reader's own Retry) recovers.
        if (silent) return;
        setThreadsError(messageOf(err, 'Could not load this mailbox.'));
        setThreadsLoad('error');
      } finally {
        if (append && req === threadReqRef.current) setLoadingMore(false);
      }
    },
    [guard401, disableFeature],
  );

  useEffect(() => {
    if (!workspace || !selectedMailboxId) {
      setThreads([]);
      setHasMore(false);
      setThreadsLoad(workspace && !selectedMailboxId ? 'ready' : 'loading');
      return;
    }
    // Changing mailbox / folder / custom folder / query closes any open thread.
    setOpenThread(null);
    setMessages([]);
    void fetchThreads(workspace, selectedMailboxId, folder, query, 0, false);
  }, [workspace, selectedMailboxId, folder, activeCustomFolderId, query, fetchThreads]);

  const refreshThreads = useCallback(() => {
    const ws = workspaceRef.current;
    const mbx = selectedMailboxIdRef.current;
    if (ws && mbx) void fetchThreads(ws, mbx, folderRef.current, query, 0, false);
  }, [query, fetchThreads]);

  const loadMore = useCallback(() => {
    const ws = workspaceRef.current;
    const mbx = selectedMailboxIdRef.current;
    if (!ws || !mbx || loadingMore) return;
    void fetchThreads(ws, mbx, folderRef.current, query, threadsRef.current.length, true);
  }, [query, loadingMore, fetchThreads]);

  // ── Custom folders / labels (Wave 3) ───────────────────────────────────────
  // Custom folders exist only on a single SOVEREIGN (stalwart) mailbox. The
  // rail hides for the unified list, external accounts, or a dormant engine —
  // and self-heals to hidden if the folders route 404/501s (feature-detect).
  const refreshFolders = useCallback(() => {
    const ws = workspaceRef.current;
    const mbxId = selectedMailboxIdRef.current;
    if (!ws || !mbxId || mbxId === ALL_INBOXES || !foldersSupportedRef.current) {
      setCustomFolders([]);
      return;
    }
    const mbx = mailboxesRef.current.find((m) => m.id === mbxId);
    // Only sovereign mailboxes have custom folders; skip gmail/microsoft.
    if (mbx && (mbx.provider === 'gmail' || mbx.provider === 'microsoft')) {
      setCustomFolders([]);
      return;
    }
    void (async () => {
      try {
        const res = await listMailFolders(ws.workspace_id, mbxId);
        if (selectedMailboxIdRef.current !== mbxId) return; // selection moved on
        setCustomFolders(res.folders.filter((f) => f.role === null));
      } catch (err) {
        if (guard401(err)) return;
        if (isMissingEndpoint(err)) {
          setFoldersSupported(false);
          setCustomFolders([]);
          return;
        }
        // Transient failure: keep whatever folders we had — never toast on this.
      }
    })();
  }, [guard401]);

  // Refresh the rail whenever the selected mailbox (or workspace) changes.
  useEffect(() => {
    refreshFolders();
  }, [selectedMailboxId, workspace, refreshFolders]);

  const selectCustomFolder = useCallback((folderId: string) => {
    // The list effect (keyed on activeCustomFolderId) closes the open thread + refetches.
    setActiveCustomFolderId(folderId);
  }, []);

  const createFolder = useCallback(
    async (name: string): Promise<TriageOutcome> => {
      const ws = workspaceRef.current;
      const mbx = selectedMailboxIdRef.current;
      const clean = name.trim();
      if (!ws || !mbx || mbx === ALL_INBOXES) return { ok: false, error: 'Pick one mailbox first.' };
      if (!clean) return { ok: false, error: 'Give the folder a name.' };
      try {
        await createMailFolder(ws.workspace_id, mbx, clean);
        refreshFolders();
        return { ok: true };
      } catch (err) {
        if (guard401(err)) return { ok: false, error: 'Session expired.' };
        if (isMissingEndpoint(err)) return { ok: false, error: 'This mailbox can’t create folders.' };
        return { ok: false, error: messageOf(err, 'Could not create the folder.') };
      }
    },
    [refreshFolders, guard401],
  );

  const renameFolder = useCallback(
    async (folderId: string, name: string): Promise<TriageOutcome> => {
      const ws = workspaceRef.current;
      const mbx = selectedMailboxIdRef.current;
      const clean = name.trim();
      if (!ws || !mbx || mbx === ALL_INBOXES) return { ok: false, error: 'Pick one mailbox first.' };
      if (!clean) return { ok: false, error: 'Give the folder a name.' };
      const before = customFoldersRef.current;
      // Optimistic rename; roll back if the engine could not apply it.
      setCustomFolders((prev) => prev.map((f) => (f.id === folderId ? { ...f, name: clean } : f)));
      try {
        const res = await renameMailFolder(ws.workspace_id, mbx, folderId, clean);
        if (!res.updated) {
          setCustomFolders(before);
          return { ok: false, error: 'Could not rename that folder.' };
        }
        return { ok: true };
      } catch (err) {
        setCustomFolders(before);
        if (guard401(err)) return { ok: false, error: 'Session expired.' };
        return { ok: false, error: messageOf(err, 'Could not rename the folder.') };
      }
    },
    [guard401],
  );

  const deleteFolder = useCallback(
    async (folderId: string): Promise<TriageOutcome> => {
      const ws = workspaceRef.current;
      const mbx = selectedMailboxIdRef.current;
      if (!ws || !mbx || mbx === ALL_INBOXES) return { ok: false, error: 'Pick one mailbox first.' };
      const before = customFoldersRef.current;
      const wasViewing = activeCustomFolderIdRef.current === folderId;
      // Optimistic removal; if we were viewing it, fall back to the inbox.
      setCustomFolders((prev) => prev.filter((f) => f.id !== folderId));
      if (wasViewing) {
        setActiveCustomFolderId(null);
        setFolder('inbox');
      }
      // Restore both the list AND the view we navigated away from, on any failure.
      const rollback = () => {
        setCustomFolders(before);
        if (wasViewing) setActiveCustomFolderId(folderId);
      };
      try {
        const res = await deleteMailFolder(ws.workspace_id, mbx, folderId);
        if (!res.deleted) {
          rollback();
          return { ok: false, error: 'That folder could not be deleted.' };
        }
        return { ok: true };
      } catch (err) {
        rollback();
        if (guard401(err)) return { ok: false, error: 'Session expired.' };
        return { ok: false, error: messageOf(err, 'Could not delete the folder.') };
      }
    },
    [guard401],
  );

  const moveThreadToFolder = useCallback(
    async (threadId: string, folderId: string): Promise<TriageOutcome> => {
      const ws = workspaceRef.current;
      const row = threadsRef.current.find((t) => t.id === threadId);
      const mbx = row?.mailbox_id ?? openThread?.mailboxId ?? selectedMailboxIdRef.current;
      if (!ws || !mbx || mbx === ALL_INBOXES) return { ok: false, error: 'Pick one mailbox first.' };
      const before = threadsRef.current;
      const prevOpen = openThreadRef.current;
      // Optimistic: pull the thread out of the current list immediately.
      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      setOpenThread((prev) => (prev?.id === threadId ? null : prev));
      // Restore BOTH the list and the reader if nothing actually moved.
      const rollback = () => {
        setThreads(before);
        if (prevOpen?.id === threadId) setOpenThread(prevOpen);
      };
      try {
        const res = await moveThreadToCustomFolder(ws.workspace_id, mbx, threadId, folderId);
        if (!res.moved) {
          rollback(); // truthful rollback — nothing actually moved
          return { ok: false, error: 'That folder is unavailable for this mailbox.' };
        }
        refreshFolders(); // the target folder's unread badge changed
        refreshCounts();
        return { ok: true };
      } catch (err) {
        rollback();
        if (guard401(err)) return { ok: false, error: 'Session expired.' };
        if (isMissingEndpoint(err)) return { ok: false, error: 'Folders are not available here.' };
        return { ok: false, error: messageOf(err, 'Could not move this conversation.') };
      }
    },
    [openThread, refreshFolders, refreshCounts, guard401],
  );

  const moveThreadsToFolder = useCallback(
    async (threadIds: string[], folderId: string): Promise<TriageOutcome> => {
      const ws = workspaceRef.current;
      if (!ws || threadIds.length === 0) return { ok: false, error: 'Nothing selected.' };
      const ids = new Set(threadIds);
      const before = threadsRef.current;
      const prevOpen = openThreadRef.current;
      const rowsById = new Map(before.map((t) => [t.id, t] as const));
      const fallbackMbx = selectedMailboxIdRef.current;
      // Optimistic: pull the whole selection out of the current list at once.
      setThreads((prev) => prev.filter((t) => !ids.has(t.id)));
      setOpenThread((prev) => (prev && ids.has(prev.id) ? null : prev));
      try {
        const results = await Promise.all(
          threadIds.map((id) => {
            const mbx = rowsById.get(id)?.mailbox_id ?? fallbackMbx;
            if (!mbx || mbx === ALL_INBOXES) return Promise.resolve({ moved: false });
            return moveThreadToCustomFolder(ws.workspace_id, mbx, id, folderId).catch(() => ({ moved: false }));
          }),
        );
        const moved = results.filter((r) => r.moved).length;
        refreshFolders(); // target folder unread badge changed
        refreshCounts();
        if (moved === threadIds.length) return { ok: true };
        // Partial/none moved server-side: reconcile with the server rather than
        // trusting the optimistic removal, so the list stays truthful.
        const mbx = selectedMailboxIdRef.current;
        if (mbx) void fetchThreads(ws, mbx, folderRef.current, queryRef.current, 0, false, true);
        return moved === 0
          ? { ok: false, error: 'Could not move the selected conversations.' }
          : { ok: true };
      } catch (err) {
        setThreads(before);
        if (prevOpen && ids.has(prevOpen.id)) setOpenThread(prevOpen);
        if (guard401(err)) return { ok: false, error: 'Session expired.' };
        if (isMissingEndpoint(err)) return { ok: false, error: 'Folders are not available here.' };
        return { ok: false, error: messageOf(err, 'Could not move the selection.') };
      }
    },
    [refreshFolders, refreshCounts, fetchThreads, guard401],
  );

  const snoozeThreadUntil = useCallback(
    async (threadId: string, until: Date): Promise<TriageOutcome> => {
      const ws = workspaceRef.current;
      const row = threadsRef.current.find((t) => t.id === threadId);
      const mbx = row?.mailbox_id ?? openThreadRef.current?.mailboxId ?? selectedMailboxIdRef.current;
      if (!ws || !mbx || mbx === ALL_INBOXES) return { ok: false, error: 'Pick one mailbox first.' };
      const before = threadsRef.current;
      const prevOpen = openThreadRef.current;
      // Optimistic: snoozing hides the thread out of the current list now.
      setThreads((prev) => prev.filter((t) => t.id !== threadId));
      setOpenThread((prev) => (prev?.id === threadId ? null : prev));
      const rollback = () => {
        setThreads(before);
        if (prevOpen?.id === threadId) setOpenThread(prevOpen);
      };
      try {
        // Pass the subject the row already carries so the Snoozed view renders a
        // human label without a server round-trip (backend resolves it if absent).
        const subject = row?.subject ?? null;
        const res = await snoozeThread(ws.workspace_id, mbx, threadId, until.toISOString(), subject);
        if (!res.snoozed) {
          rollback();
          return { ok: false, error: 'Snooze is unavailable for this mailbox.' };
        }
        refreshCounts();
        return { ok: true };
      } catch (err) {
        rollback();
        if (guard401(err)) return { ok: false, error: 'Session expired.' };
        if (isMissingEndpoint(err)) return { ok: false, error: 'Snooze is not available here.' };
        return { ok: false, error: messageOf(err, 'Could not snooze this conversation.') };
      }
    },
    [refreshCounts, guard401],
  );

  const scheduleSend = useCallback(
    async (
      body: Pick<
        ComposeBody,
        | 'to_address'
        | 'subject'
        | 'body'
        | 'body_html'
        | 'cc'
        | 'bcc'
        | 'attachments'
        | 'draft_id'
        | 'in_reply_to_thread_id'
        | 'in_reply_to'
        | 'references'
      >,
      sendAt: Date,
      mailboxId?: string,
    ): Promise<TriageOutcome & { id?: string; mailboxId?: string; ambiguous?: boolean }> => {
      const ws = workspaceRef.current;
      // Schedule from the given mailbox, else the selected sovereign one, else the
      // first — never the unified sentinel (send-later is a single-mailbox verb).
      const mbxId =
        mailboxId ??
        (selectedMailboxIdRef.current !== ALL_INBOXES ? selectedMailboxIdRef.current : null) ??
        mailboxesRef.current[0]?.id ??
        null;
      if (!ws || !mbxId) return { ok: false, error: 'No mailbox selected.' };
      if (!Number.isFinite(sendAt.getTime()) || sendAt.getTime() <= Date.now()) {
        return { ok: false, error: 'Pick a time in the future.' };
      }
      try {
        const res = await apiScheduleSend(ws.workspace_id, mbxId, {
          to_address: body.to_address,
          send_at: sendAt.toISOString(),
          ...(body.subject ? { subject: body.subject } : {}),
          ...(body.body ? { body: body.body } : {}),
          ...(body.body_html ? { body_html: body.body_html } : {}),
          ...(body.cc?.length ? { cc: body.cc } : {}),
          ...(body.bcc?.length ? { bcc: body.bcc } : {}),
          ...(body.attachments?.length ? { attachments: body.attachments } : {}),
          // Forward the draft id so the scheduled send deletes it at fire time
          // (parity with the immediate-send lane) — no orphaned "sent" draft.
          ...(body.draft_id ? { draft_id: body.draft_id } : {}),
          // Threading passthrough: a scheduled/undo-window REPLY must land in its
          // thread exactly like an immediate reply would.
          ...(body.in_reply_to_thread_id ? { in_reply_to_thread_id: body.in_reply_to_thread_id } : {}),
          ...(body.in_reply_to ? { in_reply_to: body.in_reply_to } : {}),
          ...(body.references?.length ? { references: body.references } : {}),
        });
        // Truthful: a dormant/external mailbox returns scheduled:false — surface it.
        if (!res.scheduled) return { ok: false, error: 'Send later is unavailable for this mailbox.' };
        return { ok: true, id: res.item?.id, mailboxId: mbxId };
      } catch (err) {
        if (guard401(err)) return { ok: false, error: 'Session expired.' };
        if (isMissingEndpoint(err)) return { ok: false, error: 'Send later is not available here.' };
        // A non-HTTP failure (network drop, timeout) is AMBIGUOUS — the server
        // may have committed the schedule. Callers must NOT fall back to an
        // immediate send on this, or the message can go out twice.
        const ambiguous = !(err instanceof ApiError);
        return { ok: false, ambiguous, error: messageOf(err, 'Could not schedule this message.') };
      }
    },
    [guard401],
  );

  const cancelScheduledSend = useCallback(
    async (id: string, mailboxId: string): Promise<TriageOutcome & { cancelled?: boolean }> => {
      const ws = workspaceRef.current;
      if (!ws) return { ok: false, error: 'No workspace.' };
      try {
        const res = await apiCancelScheduledSend(ws.workspace_id, mailboxId, id);
        // cancelled:false is a VALID outcome (the send already left) — the caller
        // decides how to message it; ok reflects the call, not the race.
        return { ok: true, cancelled: res.cancelled };
      } catch (err) {
        if (guard401(err)) return { ok: false, error: 'Session expired.' };
        return { ok: false, error: messageOf(err, 'Could not cancel this send.') };
      }
    },
    [guard401],
  );

  const getScheduledSendState = useCallback(
    async (
      id: string,
      mailboxId: string,
    ): Promise<'pending' | 'claimed' | 'sent' | 'cancelled' | 'failed' | null> => {
      const ws = workspaceRef.current;
      if (!ws) return null;
      try {
        const res = await apiGetScheduledSend(ws.workspace_id, mailboxId, id);
        const state = (res.item?.state ?? '').toLowerCase();
        return state === 'pending' ||
          state === 'claimed' ||
          state === 'sent' ||
          state === 'cancelled' ||
          state === 'failed'
          ? state
          : null;
      } catch {
        // Degrade quietly (older backend without the GET-one route, transient
        // network) — the undo bar simply skips its verdict rather than erroring.
        return null;
      }
    },
    [],
  );

  // ── New-mail arrival: manual Refresh + visibility-gated background poll ─────
  // Both take a SILENT fetch (no skeleton, no error-state on a transient blip)
  // so the user's scroll / selection / open thread are never reset — the list is
  // replaced in place exactly like the existing refresh, plus a counts refresh.
  const refreshingRef = useRef(false);
  const refresh = useCallback(() => {
    const ws = workspaceRef.current;
    const mbx = selectedMailboxIdRef.current;
    if (!ws || !mbx || refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    const done = fetchThreads(ws, mbx, folderRef.current, queryRef.current, 0, false, true);
    refreshCounts();
    void Promise.resolve(done).finally(() => {
      refreshingRef.current = false;
      setRefreshing(false);
    });
  }, [fetchThreads, refreshCounts]);

  const pollingRef = useRef(false);
  const pollRefresh = useCallback(() => {
    // Idle-friendly: never touch the network while the tab is hidden.
    if (document.visibilityState !== 'visible') return;
    const ws = workspaceRef.current;
    const mbx = selectedMailboxIdRef.current;
    if (!ws || !mbx) return;
    // Skip if anything is already in flight (initial load, paging, or a prior poll).
    if (pollingRef.current || threadsLoadRef.current === 'loading' || loadingMoreRef.current) return;
    pollingRef.current = true;
    const done = fetchThreads(ws, mbx, folderRef.current, queryRef.current, 0, false, true);
    refreshCounts();
    void Promise.resolve(done).finally(() => {
      pollingRef.current = false;
    });
  }, [fetchThreads, refreshCounts]);

  // Point the interval at the latest poll logic without re-arming the timer on
  // every render (the useInterval ref pattern).
  const pollRef = useRef(pollRefresh);
  pollRef.current = pollRefresh;

  useEffect(() => {
    const tick = () => pollRef.current();
    const id = window.setInterval(() => {
      // Guard here too so a hidden tab does zero work between visibility events.
      if (document.visibilityState === 'visible') tick();
    }, INBOX_POLL_MS);
    // Coming back to the tab (focus or unhide) refetches immediately.
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', tick);
    };
  }, []);

  // ── Read / unread marking (Wave 2, optimistic) ────────────────────────────
  const markRead = useCallback(
    (threadIds: string[], read: boolean) => {
      const ws = workspaceRef.current;
      if (!ws || threadIds.length === 0) return;
      const ids = new Set(threadIds);
      const rows = threadsRef.current.filter((t) => ids.has(t.id));
      // Optimistic: flip the dots + adjust the inbox unread badges.
      setThreads((prev) => prev.map((t) => (ids.has(t.id) ? { ...t, unread: !read } : t)));
      if (folderRef.current === 'inbox') {
        for (const row of rows) {
          if (row.unread === read) continue; // only rows that actually flip
          const mbx = row.mailbox_id ?? selectedMailboxIdRef.current;
          bumpUnread(mbx, read ? -1 : 1);
        }
      }
      if (!featuresRef.current.read) return;
      for (const row of rows) {
        const mbx = row.mailbox_id ?? selectedMailboxIdRef.current;
        if (!mbx || mbx === ALL_INBOXES) continue;
        void setThreadRead(ws.workspace_id, mbx, row.id, read).catch((err: unknown) => {
          if (guard401(err)) return;
          if (isMissingEndpoint(err)) disableFeature('read');
          // Fire-and-forget: the optimistic UI stands; the next refetch corrects.
        });
      }
    },
    [bumpUnread, guard401, disableFeature],
  );

  const toggleFlag = useCallback(
    (threadId: string, flagged: boolean) => {
      const ws = workspaceRef.current;
      if (!ws) return;
      const row = threadsRef.current.find((t) => t.id === threadId);
      const mbx = row?.mailbox_id ?? openThread?.mailboxId ?? selectedMailboxIdRef.current;
      setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, flagged } : t)));
      if (openThread?.id === threadId) {
        setMessages((prev) => prev.map((m) => ({ ...m, flagged })));
      }
      if (!mbx || mbx === ALL_INBOXES) return;
      void setThreadFlags(ws.workspace_id, mbx, threadId, { flagged }).catch((err: unknown) => {
        if (guard401(err)) return;
        if (isMissingEndpoint(err)) disableFeature('read');
      });
    },
    [openThread, guard401, disableFeature],
  );

  // ── Open thread + messages ────────────────────────────────────────────────
  const selectThread = useCallback(
    (threadId: string | null, mailboxId?: string) => {
      if (!threadId) {
        setOpenThread(null);
        return;
      }
      const row = threadsRef.current.find((t) => t.id === threadId);
      const selected = selectedMailboxIdRef.current;
      const mbx =
        mailboxId ?? row?.mailbox_id ?? (selected && selected !== ALL_INBOXES ? selected : null);
      setOpenThread({ id: threadId, mailboxId: mbx });
      // Opening an unread thread clears the dot (optimistic) + tells the backend.
      if (row?.unread) markRead([threadId], true);
    },
    [markRead],
  );

  useEffect(() => {
    if (!workspace || !openThread?.mailboxId) {
      setMessages([]);
      return;
    }
    const req = ++messageReqRef.current;
    setMessagesLoad('loading');
    void (async () => {
      try {
        const res = await getMailThread(workspace.workspace_id, openThread.mailboxId!, openThread.id);
        if (req !== messageReqRef.current) return;
        setMessages(res.messages);
        setMessagesError(null);
        setMessagesLoad('ready');
      } catch (err) {
        if (req !== messageReqRef.current) return;
        if (guard401(err)) return;
        setMessagesError(messageOf(err, 'Could not load this conversation.'));
        setMessagesLoad('error');
      }
    })();
  }, [workspace, openThread, guard401]);

  const unified = selectedMailboxId === ALL_INBOXES;
  const selectedMailbox = unified
    ? null
    : mailboxes.find((m) => m.id === selectedMailboxId) ?? null;
  const composeMailbox = unified
    ? mailboxes.find((m) => m.id === openThread?.mailboxId) ?? mailboxes[0] ?? null
    : selectedMailbox;

  const selectMailbox = useCallback((mailboxId: string) => {
    setSelectedMailboxId(mailboxId);
    // A custom folder belongs to one mailbox — leaving the mailbox leaves it.
    setActiveCustomFolderId(null);
  }, []);

  // Switching folders (the effect above closes the open thread + refetches).
  const selectFolder = useCallback((next: MailFolder) => {
    // Clearing the active custom folder is what makes the list effect re-run and
    // fetchThreads route back to a SYSTEM folder — without this, picking a system
    // folder while a custom one is open is a no-op dead-end.
    setActiveCustomFolderId(null);
    setFolder(next);
  }, []);

  const setQuery = useCallback((q: string) => {
    setQueryState(q.trim());
  }, []);

  // Re-fetch the open thread's messages (after a reply lands a new row).
  const refreshOpenThread = useCallback(async () => {
    const ws = workspaceRef.current;
    if (!ws || !openThread?.mailboxId) return;
    const req = ++messageReqRef.current;
    try {
      const res = await getMailThread(ws.workspace_id, openThread.mailboxId, openThread.id);
      if (req !== messageReqRef.current) return;
      setMessages(res.messages);
      setMessagesError(null);
      setMessagesLoad('ready');
    } catch (err) {
      if (req !== messageReqRef.current) return;
      if (guard401(err)) return;
      // Keep what we have; the compose itself already reported its own status.
    }
  }, [openThread, guard401]);

  const compose = useCallback(
    async (body: ComposeBody, mailboxId?: string): Promise<ComposeOutcome> => {
      const ws = workspaceRef.current;
      // Replies route to the open thread's mailbox; new mail to the compose mailbox.
      const isReply = !!body.in_reply_to_thread_id;
      const mbxId =
        mailboxId ??
        (isReply ? openThread?.mailboxId : null) ??
        (selectedMailboxIdRef.current !== ALL_INBOXES ? selectedMailboxIdRef.current : null) ??
        mailboxesRef.current[0]?.id ??
        null;
      if (!ws || !mbxId) {
        return { ok: false, error: 'No mailbox selected.' };
      }
      try {
        const message = await composeMail(ws.workspace_id, mbxId, body);
        // Refresh the thread list so a brand-new thread/draft shows up.
        void fetchThreads(ws, selectedMailboxIdRef.current ?? mbxId, folderRef.current, query, 0, false);
        // If this was a reply into the open thread, pull its new message in too.
        if (isReply && body.in_reply_to_thread_id === openThread?.id) {
          void refreshOpenThread();
        }
        return { ok: true, message };
      } catch (err) {
        if (guard401(err)) return { ok: false, error: 'Session expired.' };
        return { ok: false, error: messageOf(err, 'Could not record the message.') };
      }
    },
    [openThread, query, fetchThreads, refreshOpenThread, guard401],
  );

  const reply = useCallback(
    (body: Omit<ComposeBody, 'in_reply_to_thread_id'>): Promise<ComposeOutcome> => {
      if (!openThread) return Promise.resolve({ ok: false, error: 'No open thread.' });
      return compose({ ...body, in_reply_to_thread_id: openThread.id });
    },
    [compose, openThread],
  );

  const triage = useCallback(
    async (
      threadId: string,
      disposition: ThreadDisposition,
      opts?: TriageOpts,
    ): Promise<TriageOutcome> => {
      const ws = workspaceRef.current;
      if (!ws) return { ok: false, error: 'No workspace.' };
      try {
        await setThreadDisposition(ws.workspace_id, threadId, {
          disposition,
          ...(opts?.blockSender ? { block_sender: true } : {}),
          ...(opts?.trustSender ? { trust_sender: true } : {}),
          ...(opts?.senderAddress ? { sender_address: opts.senderAddress } : {}),
        });
        // The thread likely left this folder — refresh the list + the badges.
        const mbx = selectedMailboxIdRef.current;
        if (mbx) void fetchThreads(ws, mbx, folderRef.current, query, 0, false);
        refreshCounts();
        // If the triaged thread was open, close it (it moved away from this folder).
        setOpenThread((prev) => (prev?.id === threadId ? null : prev));
        return { ok: true };
      } catch (err) {
        if (guard401(err)) return { ok: false, error: 'Session expired.' };
        return { ok: false, error: messageOf(err, 'Could not move this conversation.') };
      }
    },
    [query, fetchThreads, refreshCounts, guard401],
  );

  /** Does a bulk action move threads OUT of the current folder's list? */
  const movesOutOfFolder = (action: BulkAction, f: MailFolder): boolean => {
    if (action === 'read' || action === 'unread') return false;
    return action !== f; // archiving in Archive (etc.) is a no-op for the list
  };

  const bulk = useCallback(
    async (threadIds: string[], action: BulkAction): Promise<BulkOutcome> => {
      const ws = workspaceRef.current;
      if (!ws || threadIds.length === 0) return { ok: false, error: 'Nothing selected.' };
      if (action === 'read' || action === 'unread') {
        // Optimistic flip; the bulk endpoint does the write in one round trip.
        const ids = new Set(threadIds);
        const read = action === 'read';
        const rows = threadsRef.current.filter((t) => ids.has(t.id));
        setThreads((prev) => prev.map((t) => (ids.has(t.id) ? { ...t, unread: !read } : t)));
        if (folderRef.current === 'inbox') {
          for (const row of rows) {
            if (row.unread === read) continue;
            bumpUnread(row.mailbox_id ?? selectedMailboxIdRef.current, read ? -1 : 1);
          }
        }
      }
      const before = threadsRef.current;
      const removed = movesOutOfFolder(action, folderRef.current);
      if (removed) {
        const ids = new Set(threadIds);
        setThreads((prev) => prev.filter((t) => !ids.has(t.id)));
        setOpenThread((prev) => (prev && threadIds.includes(prev.id) ? null : prev));
      }
      try {
        const result = await bulkThreadAction(ws.workspace_id, threadIds, action);
        refreshCounts();
        // Backfill the page after removals (the server list shifted under us).
        if (removed) {
          const mbx = selectedMailboxIdRef.current;
          if (mbx) void fetchThreads(ws, mbx, folderRef.current, query, 0, false);
        }
        return { ok: true, result };
      } catch (err) {
        if (removed) setThreads(before); // roll the optimistic removal back
        if (guard401(err)) return { ok: false, error: 'Session expired.' };
        if (isMissingEndpoint(err)) {
          disableFeature('bulk');
          return { ok: false, unsupported: true };
        }
        return { ok: false, error: messageOf(err, 'Could not apply that to the selection.') };
      }
    },
    [query, bumpUnread, fetchThreads, refreshCounts, guard401, disableFeature],
  );

  const emptyFolder = useCallback(
    async (target: 'trash' | 'spam'): Promise<TriageOutcome> => {
      const ws = workspaceRef.current;
      const mbx = selectedMailboxIdRef.current;
      if (!ws || !mbx || mbx === ALL_INBOXES) return { ok: false, error: 'Pick one mailbox first.' };
      try {
        await emptyMailFolder(ws.workspace_id, mbx, target);
        setThreads([]);
        setOpenThread(null);
        void fetchThreads(ws, mbx, target, query, 0, false);
        return { ok: true };
      } catch (err) {
        if (guard401(err)) return { ok: false };
        return { ok: false, error: messageOf(err, 'Could not empty this folder.') };
      }
    },
    [fetchThreads, guard401, query],
  );

  return {
    workspace,
    load,
    error,
    features,
    mailboxes,
    selectedMailbox,
    unified,
    selectMailbox,
    composeMailbox,
    counts,
    refreshCounts,
    folder,
    selectFolder,
    query,
    setQuery,
    threads,
    threadsLoad,
    threadsError,
    refreshThreads,
    refresh,
    refreshing,
    hasMore,
    loadingMore,
    loadMore,
    selectedThreadId: openThread?.id ?? null,
    selectedThreadMailboxId: openThread?.mailboxId ?? null,
    selectThread,
    messages,
    messagesLoad,
    messagesError,
    markRead,
    toggleFlag,
    compose,
    reply,
    triage,
    bulk,
    emptyFolder,
    foldersSupported,
    customFolders,
    activeCustomFolderId,
    activeCustomFolder: customFolders.find((f) => f.id === activeCustomFolderId) ?? null,
    selectCustomFolder,
    createFolder,
    renameFolder,
    deleteFolder,
    moveThreadToFolder,
    moveThreadsToFolder,
    snoozeThreadUntil,
    scheduleSend,
    cancelScheduledSend,
    getScheduledSendState,
  };
}

/** Relative-time formatter shared by the list + thread panes (suite copy). */
export function formatWhen(iso: string | null): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  const diffMs = Date.now() - ts;
  const mins = Math.round(diffMs / 60000);
  // Terse, Superhuman-style stamps — the list reads cleaner without "ago" on
  // every row. Older-than-a-week collapses to a date; older-than-a-year adds it.
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** A friendly initials/label for a participant or address. */
export function participantLabel(p: MailParticipantLike | null | undefined): string {
  if (!p) return 'Unknown';
  return p.name?.trim() || p.address || 'Unknown';
}

interface MailParticipantLike {
  address: string;
  name: string | null;
}

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
  emptyMailFolder,
  getMailCounts,
  getMailThread,
  isMissingEndpoint,
  listAggregateThreads,
  listMailMailboxes,
  listMailThreads,
  setThreadDisposition,
  setThreadFlags,
  setThreadRead,
  type BulkAction,
  type BulkActionResponse,
  type ComposeBody,
  type MailboxCounts,
  type MailboxPick,
  type MailFolder,
  type MessageComposeView,
  type MessageView,
  type ThreadDisposition,
  type ThreadView,
} from '@/lib/mailApi';

/** Sentinel mailbox id for the unified "All inboxes" list (Wave 2). */
export const ALL_INBOXES = '__all_inboxes__';

/** Page size for thread lists (also the load-more step). */
const PAGE_SIZE = 50;

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

  const [threads, setThreads] = useState<ThreadView[]>([]);
  const [threadsLoad, setThreadsLoad] = useState<Load>('loading');
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

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
  const selectedMailboxIdRef = useRef(selectedMailboxId);
  selectedMailboxIdRef.current = selectedMailboxId;
  const folderRef = useRef(folder);
  folderRef.current = folder;
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

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
    ) => {
      const req = ++threadReqRef.current;
      if (append) {
        setLoadingMore(true);
      } else {
        setThreadsLoad('loading');
        setLoadingMore(false); // a fresh list supersedes any in-flight load-more
      }
      try {
        const opts = { folder: f, limit: PAGE_SIZE, q: q || undefined, offset: offset || undefined };
        const res =
          mailboxId === ALL_INBOXES
            ? await listAggregateThreads(ws.workspace_id, opts)
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
    // Changing mailbox / folder / query closes any open thread.
    setOpenThread(null);
    setMessages([]);
    void fetchThreads(workspace, selectedMailboxId, folder, query, 0, false);
  }, [workspace, selectedMailboxId, folder, query, fetchThreads]);

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
  }, []);

  // Switching folders (the effect above closes the open thread + refetches).
  const selectFolder = useCallback((next: MailFolder) => {
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

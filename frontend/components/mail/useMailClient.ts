'use client';

/**
 * Data layer for the `/mail` client (the "retire Outlook" surface).
 *
 * Mirrors `useAgentInbox`: a `load` discriminator + `error` string + workspace
 * resolution via the active org (`useActiveWorkspace`), plus a 401 guard to login.
 * It coordinates the three reads of a 3-pane mail client — the mailbox picker,
 * the selected mailbox's thread list, and the selected thread's messages — each
 * with its own independent load state so a slow pane never blanks the others.
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
  composeMail,
  getMailThread,
  listMailMailboxes,
  listMailThreads,
  setThreadDisposition,
  type ComposeBody,
  type MailboxPick,
  type MailFolder,
  type MessageComposeView,
  type MessageView,
  type ThreadDisposition,
  type ThreadView,
} from '@/lib/mailApi';

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

/** Optional sender side-effects to apply atomically with a triage. */
export interface TriageOpts {
  blockSender?: boolean;
  trustSender?: boolean;
  senderAddress?: string;
}

export interface UseMailClient {
  /** The workspace the client is scoped to (null = caller has no membership). */
  workspace: MyWorkspace | null;
  /** Top-level load: workspace + the mailbox list. */
  load: Load;
  error: string | null;

  /** The pickable mailboxes (inbox picker). */
  mailboxes: MailboxPick[];
  /** The currently selected mailbox (null until the list resolves). */
  selectedMailbox: MailboxPick | null;
  selectMailbox: (mailboxId: string) => void;

  /** The folder the thread list is scoped to (defaults to inbox). */
  folder: MailFolder;
  /** Switch folders — closes any open thread and refetches the list. */
  selectFolder: (folder: MailFolder) => void;

  /** Thread list for the selected mailbox + its own load state. */
  threads: ThreadView[];
  threadsLoad: Load;
  threadsError: string | null;
  refreshThreads: () => void;

  /** The selected thread id (null = none open). */
  selectedThreadId: string | null;
  selectThread: (threadId: string | null) => void;
  /** Messages of the open thread + its own load state. */
  messages: MessageView[];
  messagesLoad: Load;
  messagesError: string | null;

  /** Compose a new message in the selected mailbox. Refreshes threads on success. */
  compose: (body: ComposeBody) => Promise<ComposeOutcome>;
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

  const [mailboxes, setMailboxes] = useState<MailboxPick[]>([]);
  const [selectedMailboxId, setSelectedMailboxId] = useState<string | null>(null);
  const [folder, setFolder] = useState<MailFolder>('inbox');

  const [threads, setThreads] = useState<ThreadView[]>([]);
  const [threadsLoad, setThreadsLoad] = useState<Load>('loading');
  const [threadsError, setThreadsError] = useState<string | null>(null);

  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [messagesLoad, setMessagesLoad] = useState<Load>('loading');
  const [messagesError, setMessagesError] = useState<string | null>(null);

  // Guards stale async writes when the selection changes mid-flight.
  const threadReqRef = useRef(0);
  const messageReqRef = useRef(0);

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
  }, [activeWorkspaceId, workspaceLoad, guard401]);

  // Load the thread list whenever the selected mailbox or folder changes.
  const fetchThreads = useCallback(
    async (ws: MyWorkspace, mailboxId: string, f: MailFolder) => {
      const req = ++threadReqRef.current;
      setThreadsLoad('loading');
      try {
        const res = await listMailThreads(ws.workspace_id, mailboxId, 50, f);
        if (req !== threadReqRef.current) return; // superseded
        setThreads(res.threads);
        setThreadsError(null);
        setThreadsLoad('ready');
      } catch (err) {
        if (req !== threadReqRef.current) return;
        if (guard401(err)) return;
        setThreadsError(messageOf(err, 'Could not load this mailbox.'));
        setThreadsLoad('error');
      }
    },
    [guard401],
  );

  useEffect(() => {
    if (!workspace || !selectedMailboxId) {
      setThreads([]);
      setThreadsLoad(workspace && !selectedMailboxId ? 'ready' : 'loading');
      return;
    }
    // Changing mailbox or folder closes any open thread.
    setSelectedThreadId(null);
    setMessages([]);
    void fetchThreads(workspace, selectedMailboxId, folder);
  }, [workspace, selectedMailboxId, folder, fetchThreads]);

  // Load messages whenever a thread is opened.
  useEffect(() => {
    if (!workspace || !selectedMailboxId || !selectedThreadId) {
      setMessages([]);
      return;
    }
    const req = ++messageReqRef.current;
    setMessagesLoad('loading');
    void (async () => {
      try {
        const res = await getMailThread(workspace.workspace_id, selectedMailboxId, selectedThreadId);
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
  }, [workspace, selectedMailboxId, selectedThreadId, guard401]);

  const selectedMailbox =
    mailboxes.find((m) => m.id === selectedMailboxId) ?? null;

  const selectMailbox = useCallback((mailboxId: string) => {
    setSelectedMailboxId(mailboxId);
  }, []);

  const selectThread = useCallback((threadId: string | null) => {
    setSelectedThreadId(threadId);
  }, []);

  // Switching folders (the effect above closes the open thread + refetches).
  const selectFolder = useCallback((next: MailFolder) => {
    setFolder(next);
  }, []);

  const refreshThreads = useCallback(() => {
    if (workspace && selectedMailboxId) void fetchThreads(workspace, selectedMailboxId, folder);
  }, [workspace, selectedMailboxId, folder, fetchThreads]);

  // Re-fetch the open thread's messages (after a reply lands a new row).
  const refreshOpenThread = useCallback(async () => {
    if (!workspace || !selectedMailboxId || !selectedThreadId) return;
    const req = ++messageReqRef.current;
    try {
      const res = await getMailThread(workspace.workspace_id, selectedMailboxId, selectedThreadId);
      if (req !== messageReqRef.current) return;
      setMessages(res.messages);
      setMessagesError(null);
      setMessagesLoad('ready');
    } catch (err) {
      if (req !== messageReqRef.current) return;
      if (guard401(err)) return;
      // Keep what we have; the compose itself already reported its own status.
    }
  }, [workspace, selectedMailboxId, selectedThreadId, guard401]);

  const compose = useCallback(
    async (body: ComposeBody): Promise<ComposeOutcome> => {
      if (!workspace || !selectedMailboxId) {
        return { ok: false, error: 'No mailbox selected.' };
      }
      try {
        const message = await composeMail(workspace.workspace_id, selectedMailboxId, body);
        // Refresh the thread list so a brand-new thread/draft shows up.
        void fetchThreads(workspace, selectedMailboxId, folder);
        // If this was a reply into the open thread, pull its new message in too.
        if (body.in_reply_to_thread_id && body.in_reply_to_thread_id === selectedThreadId) {
          void refreshOpenThread();
        }
        return { ok: true, message };
      } catch (err) {
        if (guard401(err)) return { ok: false, error: 'Session expired.' };
        return { ok: false, error: messageOf(err, 'Could not record the message.') };
      }
    },
    [workspace, selectedMailboxId, folder, selectedThreadId, fetchThreads, refreshOpenThread, guard401],
  );

  const reply = useCallback(
    (body: Omit<ComposeBody, 'in_reply_to_thread_id'>): Promise<ComposeOutcome> => {
      if (!selectedThreadId) return Promise.resolve({ ok: false, error: 'No open thread.' });
      return compose({ ...body, in_reply_to_thread_id: selectedThreadId });
    },
    [compose, selectedThreadId],
  );

  const triage = useCallback(
    async (
      threadId: string,
      disposition: ThreadDisposition,
      opts?: TriageOpts,
    ): Promise<TriageOutcome> => {
      if (!workspace) return { ok: false, error: 'No workspace.' };
      try {
        await setThreadDisposition(workspace.workspace_id, threadId, {
          disposition,
          ...(opts?.blockSender ? { block_sender: true } : {}),
          ...(opts?.trustSender ? { trust_sender: true } : {}),
          ...(opts?.senderAddress ? { sender_address: opts.senderAddress } : {}),
        });
        // The thread likely left this folder — refresh the list.
        if (selectedMailboxId) void fetchThreads(workspace, selectedMailboxId, folder);
        // If the triaged thread was open, close it (it moved away from this folder).
        if (threadId === selectedThreadId) setSelectedThreadId(null);
        return { ok: true };
      } catch (err) {
        if (guard401(err)) return { ok: false, error: 'Session expired.' };
        return { ok: false, error: messageOf(err, 'Could not move this conversation.') };
      }
    },
    [workspace, selectedMailboxId, folder, selectedThreadId, fetchThreads, guard401],
  );

  return {
    workspace,
    load,
    error,
    mailboxes,
    selectedMailbox,
    selectMailbox,
    folder,
    selectFolder,
    threads,
    threadsLoad,
    threadsError,
    refreshThreads,
    selectedThreadId,
    selectThread,
    messages,
    messagesLoad,
    messagesError,
    compose,
    reply,
    triage,
  };
}

/** Relative-time formatter shared by the list + thread panes (suite copy). */
export function formatWhen(iso: string | null): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  const diffMs = Date.now() - ts;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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

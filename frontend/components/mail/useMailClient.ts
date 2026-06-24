'use client';

/**
 * Data layer for the `/mail` client (the "retire Outlook" surface).
 *
 * Mirrors `useAgentInbox`: a `load` discriminator + `error` string + workspace
 * resolution via `pickActiveWorkspace`, plus a 401 guard that bounces to login.
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
import { ApiError, fetchMyWorkspaces, type MyWorkspace } from '@/lib/api';
import { pickActiveWorkspace } from '@/lib/workspace';
import {
  composeMail,
  getMailThread,
  listMailMailboxes,
  listMailThreads,
  type ComposeBody,
  type MailboxPick,
  type MessageComposeView,
  type MessageView,
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

  // Resolve the active workspace once, then load its mailboxes.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const ws = pickActiveWorkspace(await fetchMyWorkspaces());
        if (!alive) return;
        setWorkspace(ws);
        if (!ws) {
          setLoad('ready');
          return;
        }
        const res = await listMailMailboxes(ws.workspace_id);
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
  }, [guard401]);

  // Load the thread list whenever the selected mailbox changes.
  const fetchThreads = useCallback(
    async (ws: MyWorkspace, mailboxId: string) => {
      const req = ++threadReqRef.current;
      setThreadsLoad('loading');
      try {
        const res = await listMailThreads(ws.workspace_id, mailboxId);
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
    // Changing mailbox closes any open thread.
    setSelectedThreadId(null);
    setMessages([]);
    void fetchThreads(workspace, selectedMailboxId);
  }, [workspace, selectedMailboxId, fetchThreads]);

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

  const refreshThreads = useCallback(() => {
    if (workspace && selectedMailboxId) void fetchThreads(workspace, selectedMailboxId);
  }, [workspace, selectedMailboxId, fetchThreads]);

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
        void fetchThreads(workspace, selectedMailboxId);
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
    [workspace, selectedMailboxId, selectedThreadId, fetchThreads, refreshOpenThread, guard401],
  );

  const reply = useCallback(
    (body: Omit<ComposeBody, 'in_reply_to_thread_id'>): Promise<ComposeOutcome> => {
      if (!selectedThreadId) return Promise.resolve({ ok: false, error: 'No open thread.' });
      return compose({ ...body, in_reply_to_thread_id: selectedThreadId });
    },
    [compose, selectedThreadId],
  );

  return {
    workspace,
    load,
    error,
    mailboxes,
    selectedMailbox,
    selectMailbox,
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

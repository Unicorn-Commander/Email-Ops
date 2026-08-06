'use client';

/**
 * AgentChat — the conversational surface of the Email-Ops command center. The
 * operator types natural language ("summarize my unread", "what needs me
 * today?", "draft a reply to Julio declining") and the assistant replies,
 * grounded in a light context digest of the current view. This is the thing a
 * plain mailbox can't do: an inbox you can talk to.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/components/ui';
import {
  approveAgentInboxItem,
  assistantChat,
  assistantChatStream,
  rejectAgentInboxItem,
  type AssistantAction,
} from '@/lib/api';
import { useActiveWorkspace } from '@/components/ActiveWorkspaceProvider';
import { coerceCleanupTargets } from '@/lib/cleanupTargets';
import { CleanupTargetsList } from './CleanupTargetsList';
import { ArchiveIcon, RobotIcon, SendSolidIcon, TrashIcon } from './icons';

/** Inline **bold** and `code` within one line → React nodes (no HTML injection). */
function inlineMd(text: string, base: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] != null) {
      out.push(
        <strong key={`${base}b${i}`} className="font-semibold text-primary">
          {m[1]}
        </strong>,
      );
    } else if (m[2] != null) {
      out.push(
        <code key={`${base}c${i}`} className="rounded bg-surface-base px-1 py-0.5 text-[12px] mono">
          {m[2]}
        </code>,
      );
    }
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Minimal, safe markdown → JSX for the assistant's replies (headings, bold,
 *  bullet and numbered lists, paragraphs). Builds React nodes, never HTML. */
function renderMarkdown(text: string): ReactNode {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let k = 0;
  const flush = () => {
    if (!list) return;
    const { ordered, items } = list;
    blocks.push(
      ordered ? (
        <ol key={`k${k++}`} className="ml-4 list-decimal space-y-0.5">
          {items.map((it, ix) => (
            <li key={ix}>{inlineMd(it, `li${k}-${ix}-`)}</li>
          ))}
        </ol>
      ) : (
        <ul key={`k${k++}`} className="ml-4 list-disc space-y-0.5">
          {items.map((it, ix) => (
            <li key={ix}>{inlineMd(it, `li${k}-${ix}-`)}</li>
          ))}
        </ul>
      ),
    );
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (h) {
      flush();
      blocks.push(
        <p key={`k${k++}`} className="mt-1.5 font-semibold text-primary first:mt-0">
          {inlineMd(h[2], `h${k}-`)}
        </p>,
      );
    } else if (ul) {
      if (!list || list.ordered) {
        flush();
        list = { ordered: false, items: [] };
      }
      list.items.push(ul[1]);
    } else if (ol) {
      if (!list || !list.ordered) {
        flush();
        list = { ordered: true, items: [] };
      }
      list.items.push(ol[1]);
    } else {
      flush();
      blocks.push(<p key={`k${k++}`}>{inlineMd(line, `p${k}-`)}</p>);
    }
  }
  flush();
  return <div className="space-y-1.5">{blocks}</div>;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'action';
  text: string;
  pending?: boolean;
  error?: boolean;
  /** For role:'action' — a staged draft the user can approve/discard inline. */
  action?: AssistantAction;
}

const SUGGESTIONS = [
  'Summarize my unread',
  'What needs me today?',
  'Who’s waiting on a reply?',
  'Draft a polite decline',
];

let msgSeq = 0;
const nextId = () => `m${++msgSeq}`;

export function AgentChat({
  getContext,
}: {
  /** Evaluated at send time so the assistant always sees the current view. */
  getContext?: () => Record<string, unknown>;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const router = useRouter();
  const { activeWorkspace } = useActiveWorkspace();
  const workspaceId = activeWorkspace?.workspace_id ?? null;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || busy) return;
      setInput('');
      const userMsg: ChatMessage = { id: nextId(), role: 'user', text };
      const thinking: ChatMessage = { id: nextId(), role: 'assistant', text: '', pending: true };
      setMessages((m) => [...m, userMsg, thinking]);
      setBusy(true);
      try {
        const ctx = getContext?.() ?? {};
        if (workspaceId) {
          // Streamed reply — types out live as tokens arrive.
          let acc = '';
          await assistantChatStream(workspaceId, text, ctx, {
            onToken: (delta) => {
              acc += delta;
              setMessages((m) =>
                m.map((x) => (x.id === thinking.id ? { ...x, text: acc, pending: false } : x)),
              );
            },
            onError: () => {
              setMessages((m) =>
                m.map((x) => (x.id === thinking.id ? { ...x, pending: false, error: true } : x)),
              );
            },
            onActions: (actions) => {
              const cards = actions.filter((a) => a && (a.kind === 'draft' || a.kind === 'cleanup'));
              if (cards.length === 0) return;
              setMessages((m) => [
                ...m,
                ...cards.map((a) => ({
                  id: nextId(),
                  role: 'action' as const,
                  text: '',
                  action: a,
                })),
              ]);
            },
          });
          // Settle the bubble: drop the typing state and guard the empty-reply edge.
          setMessages((m) =>
            m.map((x) => {
              if (x.id !== thinking.id) return x;
              if (x.error) return { ...x, pending: false };
              return { ...x, pending: false, text: x.text || '(No response.)' };
            }),
          );
        } else {
          // No active workspace resolved — fall back to the buffered turn.
          const res = await assistantChat(text, ctx);
          setMessages((m) =>
            m.map((x) =>
              x.id === thinking.id
                ? { ...x, text: res.response, pending: false, error: !res.ok }
                : x,
            ),
          );
        }
      } catch {
        setMessages((m) =>
          m.map((x) =>
            x.id === thinking.id
              ? {
                  ...x,
                  text: x.text || 'Something went wrong reaching the assistant. Try again.',
                  pending: false,
                  error: true,
                }
              : x,
          ),
        );
      } finally {
        setBusy(false);
        taRef.current?.focus();
      }
    },
    [busy, getContext, workspaceId],
  );

  const empty = messages.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3.5 py-4">
        {empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 px-2 text-center">
            <span className="grid h-11 w-11 place-items-center rounded-2xl bg-accent/15 text-accent">
              <RobotIcon className="h-5 w-5" />
            </span>
            <div className="space-y-1">
              <p className="text-[13px] font-semibold text-primary">Ask your inbox anything</p>
              <p className="mx-auto max-w-[220px] text-[12px] leading-5 text-tertiary">
                I can see what you’re looking at — summarize, find, triage, or draft a reply.
              </p>
            </div>
            <div className="flex flex-col gap-1.5 self-stretch">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void send(s)}
                  className="rounded-lg border border-subtle bg-surface-base/50 px-3 py-2 text-left text-[12px] text-secondary transition-colors hover:border-accent/50 hover:bg-accent/[0.06] hover:text-primary"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) =>
            m.role === 'action' && m.action ? (
              <InlineActionCard
                key={m.id}
                action={m.action}
                workspaceId={workspaceId}
                onReview={() => router.push('/agent-inbox')}
              />
            ) : (
              <Bubble key={m.id} m={m} />
            ),
          )
        )}
      </div>

      <form
        className="border-t border-subtle p-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <div className="flex items-end gap-2 rounded-xl border border-border bg-surface-base px-2.5 py-2 transition-colors focus-within:border-accent/60">
          <textarea
            ref={taRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            placeholder="Message your inbox…"
            className="max-h-28 min-h-[20px] flex-1 resize-none bg-transparent text-[13px] leading-5 text-primary outline-none placeholder:text-tertiary"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            aria-label="Send"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
          >
            <SendSolidIcon className="h-[15px] w-[15px]" />
          </button>
        </div>
      </form>
    </div>
  );
}

function Bubble({ m }: { m: ChatMessage }) {
  if (m.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent px-3 py-2 text-[13px] leading-5 text-white">
          {m.text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-2">
      <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent/15 text-accent">
        <RobotIcon className="h-[13px] w-[13px]" />
      </span>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl rounded-tl-md px-3 py-2 text-[13px] leading-5',
          m.error ? 'bg-danger/10 text-danger' : 'bg-surface-overlay text-secondary',
        )}
      >
        {m.pending ? (
          <TypingDots />
        ) : m.error ? (
          <span className="whitespace-pre-wrap">{m.text}</span>
        ) : (
          renderMarkdown(m.text)
        )}
      </div>
    </div>
  );
}

/**
 * The in-chat confirm card for a draft the assistant staged into the approval
 * queue. Nothing was sent — Approve & send hands it to the send lane (via the
 * existing agent-inbox approve endpoint), Discard rejects it. Both refresh the
 * rail/badge by dispatching `agent-inbox:changed`, mirroring AgentDraftCard.
 */
function InlineActionCard({
  action,
  workspaceId,
  onReview,
}: {
  action: AssistantAction;
  workspaceId: string | null;
  onReview: () => void;
}) {
  const [state, setState] = useState<'idle' | 'sending' | 'discarding' | 'sent' | 'discarded'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);

  const isCleanup = action.kind === 'cleanup';
  const itemId = typeof action.item_id === 'string' ? action.item_id : null;
  const to = action.to ?? null;
  const subject = action.subject ?? null;
  const preview = action.preview ?? '';
  const stageFailed = Boolean(action.error) || !itemId;

  // Cleanup verb → icon + accent (Archive is non-destructive; Trash/Delete remove).
  const cleanupVerb = String(action.action ?? 'TRASH').toUpperCase();
  const CleanupIcon = cleanupVerb === 'ARCHIVE' ? ArchiveIcon : TrashIcon;
  // The concrete "what would this touch" preview (senders / subjects), when staged.
  const cleanupTargets = isCleanup ? coerceCleanupTargets(action.targets) : null;
  const cleanupWhy = isCleanup && typeof action.reason === 'string' ? action.reason.trim() : '';

  const run = async (kind: 'approve' | 'discard') => {
    if (!workspaceId || !itemId || state !== 'idle') return;
    setState(kind === 'approve' ? 'sending' : 'discarding');
    setError(null);
    try {
      if (kind === 'approve') await approveAgentInboxItem(workspaceId, itemId);
      else await rejectAgentInboxItem(workspaceId, itemId);
      window.dispatchEvent(new Event('agent-inbox:changed'));
      setState(kind === 'approve' ? 'sent' : 'discarded');
    } catch (e) {
      setError((e as Error)?.message || 'That didn’t go through. Try again.');
      setState('idle');
    }
  };

  const settled = state === 'sent' || state === 'discarded';

  const headerTitle =
    state === 'sent'
      ? isCleanup
        ? 'Cleanup done'
        : 'Sent'
      : state === 'discarded'
        ? 'Discarded'
        : isCleanup
          ? 'Cleanup ready for your approval'
          : 'Draft ready for your approval';

  const approveLabel = isCleanup
    ? state === 'sending'
      ? 'Running…'
      : 'Approve & run'
    : state === 'sending'
      ? 'Sending…'
      : 'Approve & send';

  return (
    <div className="flex gap-2">
      <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent/15 text-accent">
        <RobotIcon className="h-[13px] w-[13px]" />
      </span>
      <div className="min-w-0 flex-1 overflow-hidden rounded-2xl rounded-tl-md border border-accent/35 bg-gradient-to-b from-accent/[0.08] to-accent/[0.02]">
        <div className="flex items-center gap-2 border-b border-accent/20 px-3 py-2">
          {isCleanup && (
            <CleanupIcon
              className={cn(
                'h-[13px] w-[13px]',
                cleanupVerb === 'ARCHIVE' ? 'text-accent' : 'text-danger',
              )}
            />
          )}
          <span className="text-[12px] font-semibold text-primary">{headerTitle}</span>
          {state === 'sent' && <span className="ml-auto text-[13px] text-success">✓</span>}
        </div>

        <div className="px-3 py-2.5 text-[12px] leading-[1.55] text-secondary">
          {isCleanup && cleanupWhy && (
            <p className="mb-1.5 text-[11.5px] leading-5 text-tertiary">
              <span className="font-medium text-secondary">Why:</span> {cleanupWhy}
            </p>
          )}
          {isCleanup ? (
            cleanupTargets ? (
              <CleanupTargetsList targets={cleanupTargets} className="mb-2" />
            ) : (
              (action.count ?? 0) > 0 && (
                <p className="mb-1.5 inline-flex items-center gap-1.5 rounded-md bg-surface-base px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-tertiary">
                  <CleanupIcon className="h-3 w-3" />
                  {cleanupVerb} · {action.count} message{action.count === 1 ? '' : 's'}
                </p>
              )
            )
          ) : (
            (subject || to) && (
              <p className="mb-1.5 truncate text-[10.5px] font-medium uppercase tracking-wide text-tertiary">
                {subject || '(no subject)'}
                {to && <span className="ml-2 normal-case text-muted mono">→ {to}</span>}
              </p>
            )
          )}
          <p
            className={cn(
              'max-h-40 overflow-y-auto whitespace-pre-wrap',
              settled && 'opacity-60',
            )}
          >
            {preview}
          </p>
        </div>

        {!settled && (
          <div className="flex flex-wrap items-center gap-2 px-3 pb-2.5">
            {stageFailed ? (
              <>
                <span className="text-[11px] text-danger">
                  {action.error ??
                    (isCleanup ? 'Couldn’t stage this cleanup.' : 'Couldn’t stage this draft.')}
                </span>
                <button
                  type="button"
                  onClick={onReview}
                  className="ml-auto text-[11px] font-semibold text-accent hover:underline"
                >
                  Open Approvals
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={state !== 'idle'}
                  onClick={() => void run('approve')}
                  className={cn(
                    'inline-flex h-7 items-center gap-1.5 rounded-lg px-3 text-[12px] font-semibold text-white transition-colors disabled:opacity-50',
                    isCleanup && cleanupVerb !== 'ARCHIVE'
                      ? 'bg-danger shadow-[0_2px_8px_-2px_rgb(var(--danger)/0.5)] hover:bg-danger/90'
                      : 'bg-accent shadow-[0_2px_8px_-2px_rgb(var(--accent)/0.5)] hover:bg-accent-hover',
                  )}
                >
                  {isCleanup ? (
                    <CleanupIcon className="h-[13px] w-[13px]" />
                  ) : (
                    <SendSolidIcon className="h-[13px] w-[13px]" />
                  )}
                  {approveLabel}
                </button>
                <button
                  type="button"
                  disabled={state !== 'idle'}
                  onClick={() => void run('discard')}
                  className="inline-flex h-7 items-center rounded-lg border border-transparent px-2.5 text-[12px] font-semibold text-secondary transition-colors hover:text-primary disabled:opacity-50"
                >
                  {state === 'discarding' ? 'Discarding…' : 'Discard'}
                </button>
                <button
                  type="button"
                  onClick={onReview}
                  className="ml-auto text-[11px] font-medium text-tertiary hover:text-secondary"
                >
                  Review
                </button>
                {error && <span className="basis-full text-[11px] text-danger">{error}</span>}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-0.5" aria-label="Assistant is thinking">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-tertiary/70 eops-typing-dot"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </span>
  );
}

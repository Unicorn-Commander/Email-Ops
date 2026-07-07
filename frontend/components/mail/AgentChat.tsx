'use client';

/**
 * AgentChat — the conversational surface of the Email-Ops command center. The
 * operator types natural language ("summarize my unread", "what needs me
 * today?", "draft a reply to Julio declining") and the assistant replies,
 * grounded in a light context digest of the current view. This is the thing a
 * plain mailbox can't do: an inbox you can talk to.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/components/ui';
import { assistantChat } from '@/lib/api';
import { RobotIcon, SendSolidIcon } from './icons';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  pending?: boolean;
  error?: boolean;
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
        const res = await assistantChat(text, ctx);
        setMessages((m) =>
          m.map((x) =>
            x.id === thinking.id
              ? { ...x, text: res.response, pending: false, error: !res.ok }
              : x,
          ),
        );
      } catch {
        setMessages((m) =>
          m.map((x) =>
            x.id === thinking.id
              ? {
                  ...x,
                  text: 'Something went wrong reaching the assistant. Try again.',
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
    [busy, getContext],
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
          messages.map((m) => <Bubble key={m.id} m={m} />)
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
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
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
          'max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tl-md px-3 py-2 text-[13px] leading-5',
          m.error ? 'bg-danger/10 text-danger' : 'bg-surface-overlay text-secondary',
        )}
      >
        {m.pending ? <TypingDots /> : m.text}
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

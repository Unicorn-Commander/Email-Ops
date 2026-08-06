'use client';

/**
 * The undo-send bar: after a send enters its undo window (the message is a
 * scheduled send due in a few seconds), this bar counts down with Undo /
 * Send now, then reports a TRUTHFUL outcome — it polls the scheduled item's
 * real state (sent/failed) instead of declaring success at window close
 * (the optimistic-UI rule: confirm on success only).
 *
 * Self-contained: the page supplies callbacks; this component owns timing.
 */

import { useEffect, useRef, useState } from 'react';

/** How long a send can be recalled, user-tunable via localStorage. 0 disables. */
const UNDO_SECONDS_KEY = 'emailops.undoSendSeconds';
const UNDO_SECONDS_DEFAULT = 10;

export function readUndoSeconds(): number {
  if (typeof window === 'undefined') return UNDO_SECONDS_DEFAULT;
  try {
    const raw = window.localStorage.getItem(UNDO_SECONDS_KEY);
    if (raw === null) return UNDO_SECONDS_DEFAULT;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return UNDO_SECONDS_DEFAULT;
    return Math.min(30, Math.max(0, n));
  } catch {
    return UNDO_SECONDS_DEFAULT;
  }
}

export function writeUndoSeconds(seconds: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(UNDO_SECONDS_KEY, String(Math.min(30, Math.max(0, seconds))));
  } catch {
    /* privacy mode — the default applies */
  }
}

export interface UndoEntry {
  /** Monotonic per send — a new send replaces the bar via key change. */
  key: number;
  /** One-line human label: "To alice@acme.com — Quarterly numbers". */
  summary: string;
  /** Epoch ms when the undo window closes (the scheduled send_at). */
  expiresAt: number;
  /** Cancel + restore into the composer. 'too-late' = the worker already owns it. */
  undo: () => Promise<'restored' | 'too-late'>;
  /** Cancel the scheduled copy and send immediately. */
  sendNow: () => Promise<'sent' | 'raced' | 'failed'>;
  /** Truthful post-window verdict off the scheduled item's real state. */
  verify: () => Promise<'pending' | 'claimed' | 'sent' | 'cancelled' | 'failed' | null>;
  /** Reopen the composer seeded with this message (offered after a failure). */
  restore?: () => void;
}

type Phase = 'counting' | 'sending' | 'sent' | 'failed';

/** Verify attempts after the window closes: quick, then past one worker tick,
 *  then past a second tick (the worker fires every ~30s). */
const VERIFY_DELAYS_MS = [3_000, 15_000, 35_000];

export function UndoSendBar({
  entry,
  onDone,
  raised,
}: {
  entry: UndoEntry | null;
  onDone: (key: number) => void;
  /** Lift above other bottom-pinned chrome (the bulk-select bar). */
  raised?: boolean;
}) {
  if (!entry) return null;
  return <UndoSendBarInner key={entry.key} entry={entry} onDone={onDone} raised={raised} />;
}

function UndoSendBarInner({
  entry,
  onDone,
  raised,
}: {
  entry: UndoEntry;
  onDone: (key: number) => void;
  raised?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>('counting');
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000)),
  );
  const [busy, setBusy] = useState(false);
  const aliveRef = useRef(true);
  const phaseRef = useRef<Phase>('counting');
  phaseRef.current = phase;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Countdown tick — flips to the verifying phase when the window closes.
  useEffect(() => {
    if (phase !== 'counting') return;
    const tick = window.setInterval(() => {
      const left = Math.ceil((entry.expiresAt - Date.now()) / 1000);
      if (left <= 0) {
        setPhase('sending');
      } else {
        setSecondsLeft(left);
      }
    }, 250);
    return () => window.clearInterval(tick);
  }, [phase, entry.expiresAt]);

  // Post-window verification: poll the item's REAL state; only claim what we saw.
  useEffect(() => {
    if (phase !== 'sending') return;
    let cancelled = false;
    const timers: number[] = [];
    const attempt = (i: number) => {
      timers.push(
        window.setTimeout(() => {
          void entry.verify().then((state) => {
            if (cancelled || !aliveRef.current) return;
            if (state === 'sent') {
              setPhase('sent');
            } else if (state === 'failed') {
              setPhase('failed');
            } else if (state === 'cancelled') {
              // Undone from another tab/surface — nothing to report here.
              onDone(entry.key);
            } else if (i + 1 < VERIFY_DELAYS_MS.length) {
              attempt(i + 1);
            } else {
              // Unknown after all attempts (older backend, slow worker) — bow out
              // quietly rather than claim an outcome we never observed.
              onDone(entry.key);
            }
          });
        }, VERIFY_DELAYS_MS[i] - (i > 0 ? VERIFY_DELAYS_MS[i - 1] : 0)),
      );
    };
    attempt(0);
    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [phase, entry, onDone]);

  // Auto-dismiss the confirmed-sent state.
  useEffect(() => {
    if (phase !== 'sent') return;
    const t = window.setTimeout(() => onDone(entry.key), 2_500);
    return () => window.clearTimeout(t);
  }, [phase, entry.key, onDone]);

  const handleUndo = async () => {
    if (busy || phaseRef.current !== 'counting') return;
    setBusy(true);
    try {
      const res = await entry.undo();
      if (!aliveRef.current) return;
      if (res === 'restored') {
        onDone(entry.key); // the composer reopened with the message — bar's job is done
      } else {
        setPhase('sending'); // raced the worker: fall through to the truthful verdict
      }
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const handleSendNow = async () => {
    if (busy || phaseRef.current !== 'counting') return;
    setBusy(true);
    try {
      const res = await entry.sendNow();
      if (!aliveRef.current) return;
      if (res === 'sent') setPhase('sent');
      else if (res === 'raced') setPhase('sending');
      else setPhase('failed');
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const btn =
    'rounded-token-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50';

  return (
    <div
      role="status"
      aria-live="polite"
      className={`fixed ${raised ? 'bottom-[4.5rem]' : 'bottom-4'} left-1/2 z-[60] flex max-w-[min(92vw,34rem)] -translate-x-1/2 items-center gap-3 rounded-token-lg border border-subtle bg-surface-raised px-4 py-2.5 shadow-lg`}
    >
      {phase === 'counting' && (
        <>
          <span className="min-w-0 truncate text-sm text-secondary">
            <span className="font-medium text-primary">Sending in {secondsLeft}s</span>
            {' · '}
            {entry.summary}
          </span>
          <button type="button" disabled={busy} onClick={() => void handleUndo()} className={`${btn} bg-accent text-on-accent hover:opacity-90`}>
            Undo
          </button>
          <button type="button" disabled={busy} onClick={() => void handleSendNow()} className={`${btn} border border-subtle text-secondary hover:bg-surface-overlay`}>
            Send now
          </button>
        </>
      )}
      {phase === 'sending' && (
        <span className="text-sm text-secondary">
          Sending
          {' · '}
          <span className="text-tertiary">{entry.summary}</span>
        </span>
      )}
      {phase === 'sent' && (
        <span className="text-sm font-medium text-primary">Sent · {entry.summary}</span>
      )}
      {phase === 'failed' && (
        <>
          <span className="min-w-0 truncate text-sm font-medium text-danger">
            Couldn&apos;t send · {entry.summary}
          </span>
          {entry.restore && (
            <button
              type="button"
              onClick={() => {
                entry.restore?.();
                onDone(entry.key);
              }}
              className={`${btn} bg-accent text-on-accent hover:opacity-90`}
            >
              Edit message
            </button>
          )}
          <button type="button" onClick={() => onDone(entry.key)} className={`${btn} border border-subtle text-secondary hover:bg-surface-overlay`}>
            Dismiss
          </button>
        </>
      )}
    </div>
  );
}

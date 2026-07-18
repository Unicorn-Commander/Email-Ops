'use client';

/**
 * Desktop notifications for new inbox mail — an opt-in background poller.
 *
 * When the user turns it on (and the browser grants Notification permission),
 * this hook polls the PRIMARY inbox thread list every 60s and fires Web
 * Notification API pings for newly-arrived unread threads. Clicking one focuses
 * the app and opens that thread via the page-supplied callback.
 *
 * Design notes (the parts that are easy to get wrong):
 *  • The preference lives in localStorage ('emailops.desktopNotifications',
 *    'on'|'off', default off) and is only persisted 'on' once permission is
 *    actually GRANTED — a denied prompt never strands a phantom-on preference.
 *  • The first successful fetch after activation (or after a mailbox switch) is
 *    a BASELINE: it only records the currently-visible thread ids and never
 *    notifies — enabling on a full inbox must not unleash a notification storm.
 *  • We keep polling while the tab is hidden — that is the whole point — but we
 *    SKIP showing notifications while this window has focus (the user is
 *    already looking at the list; pinging them would be noise).
 *  • Degrade-clean: fetch errors are swallowed (console.debug); a 401 stops the
 *    polling until the user re-enables — the page owns auth routing, we never
 *    redirect from here.
 *  • Notification bodies carry sender + subject ONLY — no message previews.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import { listMailThreads, type ThreadView } from '@/lib/mailApi';

const PREF_KEY = 'emailops.desktopNotifications';
const POLL_MS = 60_000;
const POLL_LIMIT = 50;
/** At most this many individual pings per tick; anything beyond folds into one aggregate. */
const MAX_INDIVIDUAL = 3;
/** Bound the seen-id memory so week-long sessions don't grow without limit. */
const SEEN_CAP = 500;
const AGGREGATE_TAG = 'emailops-aggregate';

export interface UseDesktopNotificationsOpts {
  workspaceId: string | null;
  mailboxId: string | null;
  /**
   * A short label for the polled mailbox — ideally its EMAIL ADDRESS. Used in
   * the aggregate ping's body and to keep the user's own address out of the
   * per-thread sender line (mirrors the reader's own-participant filtering).
   */
  mailboxLabel?: string;
  /** Open the clicked thread — the page decides how (select mailbox + thread). */
  onOpenThread: (threadId: string) => void;
}

export interface UseDesktopNotificationsResult {
  /** Whether the Web Notification API exists in this browser at all. */
  supported: boolean;
  /** The persisted preference ('on' in localStorage). Polling ALSO needs permission granted. */
  enabled: boolean;
  /** Live browser permission, or 'unsupported' where the API is missing. */
  permission: NotificationPermission | 'unsupported';
  /** Flip the preference. Turning on may prompt for browser permission first. */
  setEnabled: (on: boolean) => Promise<void>;
}

function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && typeof Notification !== 'undefined';
}

function readPref(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(PREF_KEY) === 'on';
  } catch {
    return false; // storage blocked (privacy mode) → treat as off
  }
}

function writePref(on: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
  } catch {
    /* storage blocked — the toggle still works for this session's state */
  }
}

/**
 * The notification title for a thread: the first participant that isn't the
 * mailbox itself — display name if present, else the bare address.
 */
function senderOf(thread: ThreadView, selfLabel: string | null): string {
  const self = selfLabel?.trim().toLowerCase() || null;
  const other =
    thread.participants.find((p) => p.address && p.address.toLowerCase() !== self) ??
    thread.participants[0];
  return other?.name?.trim() || other?.address || 'New message';
}

export function useDesktopNotifications(
  opts: UseDesktopNotificationsOpts,
): UseDesktopNotificationsResult {
  const { workspaceId, mailboxId } = opts;

  // SSR-safe defaults; a mount effect syncs the real browser state so the
  // server render and the hydration pass agree.
  const [supported, setSupported] = useState(false);
  const [enabled, setEnabledState] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    'unsupported',
  );

  // The polling effect must NOT restart when the page re-renders with a fresh
  // callback/label closure — route both through refs (house pattern).
  const onOpenThreadRef = useRef(opts.onOpenThread);
  onOpenThreadRef.current = opts.onOpenThread;
  const mailboxLabelRef = useRef<string | null>(opts.mailboxLabel ?? null);
  mailboxLabelRef.current = opts.mailboxLabel ?? null;

  useEffect(() => {
    const ok = notificationsSupported();
    setSupported(ok);
    setPermission(ok ? Notification.permission : 'unsupported');
    setEnabledState(readPref());
  }, []);

  const setEnabled = useCallback(async (on: boolean): Promise<void> => {
    if (!on) {
      writePref(false);
      setEnabledState(false);
      return;
    }
    if (!notificationsSupported()) return; // no-op — `supported` stays false
    let perm: NotificationPermission = Notification.permission;
    if (perm === 'default') {
      try {
        perm = await Notification.requestPermission();
      } catch {
        // Ancient callback-form browsers can reject the promise form.
        perm = Notification.permission;
      }
    }
    setPermission(perm);
    if (perm !== 'granted') return; // denied / still default → never persist 'on'
    writePref(true);
    setEnabledState(true);
  }, []);

  useEffect(() => {
    if (!enabled || permission !== 'granted' || !workspaceId || !mailboxId) return;
    if (typeof window === 'undefined') return;

    let alive = true;
    let inFlight = false;
    let stopped = false; // flipped on 401 — polling halts until re-enabled
    let baselined = false;
    let timer: number | null = null;

    // Seen thread ids, insertion-ordered so we can evict the oldest. Re-seeing
    // an id refreshes its recency, so threads still sitting in the inbox never
    // age out and re-notify in long sessions.
    const seen = new Set<string>();
    const remember = (id: string): void => {
      if (seen.has(id)) seen.delete(id);
      seen.add(id);
      while (seen.size > SEEN_CAP) {
        const oldest: string | undefined = seen.keys().next().value;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
    };

    const showNotifications = (fresh: ThreadView[]): void => {
      const label = mailboxLabelRef.current;
      for (const t of fresh.slice(0, MAX_INDIVIDUAL)) {
        try {
          // Sender + subject ONLY — never a body preview.
          const n = new Notification(senderOf(t, label), {
            body: t.subject?.trim() || '(no subject)',
            tag: t.id, // re-notifies for the same thread coalesce
          });
          n.onclick = () => {
            try {
              window.focus();
            } catch {
              /* some platforms refuse programmatic focus */
            }
            onOpenThreadRef.current(t.id);
            n.close();
          };
        } catch {
          /* constructing can throw (e.g. platforms that require a service worker) */
        }
      }
      if (fresh.length > MAX_INDIVIDUAL) {
        try {
          const n = new Notification(`${fresh.length} new messages`, {
            body: label ?? undefined,
            tag: AGGREGATE_TAG,
          });
          n.onclick = () => {
            try {
              window.focus();
            } catch {
              /* ignore */
            }
            n.close();
          };
        } catch {
          /* ignore */
        }
      }
    };

    const tick = async (): Promise<void> => {
      if (!alive || stopped || inFlight) return;
      // Permission can be revoked mid-session; surface it via state (a dep of
      // this effect) so the interval tears itself down instead of pinging air.
      if (Notification.permission !== 'granted') {
        setPermission(Notification.permission);
        return;
      }
      inFlight = true;
      try {
        const res = await listMailThreads(workspaceId, mailboxId, {
          folder: 'inbox',
          limit: POLL_LIMIT,
        });
        if (!alive || stopped) return;
        const rows = res.threads;
        if (!baselined) {
          // First successful fetch after activation / mailbox switch: record
          // what's already there — never notify (no storm on enable).
          for (const t of rows) remember(t.id);
          baselined = true;
          return;
        }
        const fresh = rows.filter((t) => t.unread && !seen.has(t.id));
        for (const t of rows) remember(t.id);
        // Poll in the background on purpose — but stay quiet while this window
        // has focus: the user is already looking at the inbox.
        if (fresh.length > 0 && !document.hasFocus()) showNotifications(fresh);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          // Session gone — stop until re-enabled. The page owns auth routing.
          stopped = true;
          if (timer !== null) window.clearInterval(timer);
        } else {
          console.debug('[desktop-notifications] inbox poll failed', err);
        }
      } finally {
        inFlight = false;
      }
    };

    void tick(); // immediate baseline fetch on activation
    timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      if (timer !== null) window.clearInterval(timer);
    };
    // mailboxId in the deps intentionally resets `seen` + re-baselines on switch.
  }, [enabled, permission, workspaceId, mailboxId]);

  return { supported, enabled, permission, setEnabled };
}

'use client';

/**
 * The Phase-C poller — drains agent UI commands and APPLIES them (renders null).
 *
 * Mounted once in `AppShell`, INSIDE every provider it needs: the active org
 * (`useActiveWorkspace`) it polls under, the router it navigates with, the active
 * Space (`useActiveSpace`) it switches, the toast surface (`useToast`) it nudges,
 * and the page-local hand-off queue (`useUiCommands`) it stages mail commands in.
 *
 * It mirrors the ambient focus-gated probe idiom of `useAgentInboxPendingCount`:
 * a ~1.5s interval that ONLY drains when there is an active workspace AND the tab
 * is visible, plus an immediate drain on window 'focus' (so a command staged
 * while the tab was backgrounded applies the moment the user returns). It is
 * resilient by design — a failed drain is swallowed so the cockpit never breaks,
 * a 401 STOPS the loop rather than hard-looping a dead session, and overlapping
 * drains are guarded so a slow request can't stack up.
 *
 * Applying a command, by kind:
 *   navigate     → router.push(path) + a subtle toast
 *   switch_space → setActiveSpaceId(space_id) + toast
 *   notify       → toast({ title, body, tone })
 *   open_thread  → stage it for /mail (enqueueLocal) + router.push('/mail') + toast
 *   compose      → stage it for /mail (enqueueLocal) + router.push('/mail') + toast
 */

import { useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api';
import { useActiveWorkspace } from '@/components/ActiveWorkspaceProvider';
import { useActiveSpace } from '@/components/ActiveSpaceProvider';
import { useToast } from '@/components/ToastProvider';
import { useUiCommands } from '@/components/UiCommandProvider';
import { drainUiCommands, type UiCommandView } from '@/lib/uiCommandsApi';

/** How often to drain while the tab is visible (ms). */
const POLL_INTERVAL = 1500;
/** Apply at most this many commands per drain (a flood can't jam the cockpit). */
const MAX_APPLY = 25;

/**
 * Validate an agent-supplied `navigate` target to a SAME-ORIGIN app route — a single
 * leading "/", not "//" or "/\" (which resolve off-origin) and no scheme (e.g.
 * `javascript:`). Returns the safe path or null (drop it). This is the load-bearing
 * open-redirect / DOM-XSS guard; the backend zod refine is defense-in-depth.
 */
function safeInternalPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const path = raw.replace(/[\t\n\r]/g, ''); // browsers strip these mid-URL — defeat smuggling
  if (!/^\/(?![/\\])/.test(path)) return null;
  try {
    const u = new URL(path, 'https://internal.invalid');
    if (u.origin !== 'https://internal.invalid') return null;
    return u.pathname + u.search + u.hash;
  } catch {
    return null;
  }
}

export function UiCommandBridge() {
  const { activeWorkspace } = useActiveWorkspace();
  const activeWorkspaceId = activeWorkspace?.workspace_id ?? null;
  const router = useRouter();
  const { setActiveSpaceId } = useActiveSpace();
  const toast = useToast();
  const { enqueueLocal } = useUiCommands();

  // Guards: never overlap drains; stop the loop after a 401 (dead session).
  const drainingRef = useRef(false);
  const stoppedRef = useRef(false);

  /** Apply one drained command to the cockpit. */
  const apply = useCallback(
    (cmd: UiCommandView) => {
      switch (cmd.kind) {
        case 'navigate': {
          const path = safeInternalPath(cmd.payload.path);
          if (!path) break; // drop an off-origin / scheme path rather than navigate to it
          router.push(path);
          toast({ title: 'An agent moved you', body: path, tone: 'info' });
          break;
        }
        case 'switch_space':
          setActiveSpaceId(cmd.payload.space_id);
          toast({ title: 'An agent switched your Space', tone: 'info' });
          break;
        case 'notify':
          toast({
            title: cmd.payload.title,
            ...(cmd.payload.body !== undefined ? { body: cmd.payload.body } : {}),
            tone: cmd.payload.tone ?? 'info',
          });
          break;
        case 'open_thread':
          // The /mail page owns the mail client — stage it, then navigate there.
          enqueueLocal(cmd);
          router.push('/mail');
          toast({ title: 'An agent opened a conversation', tone: 'info' });
          break;
        case 'compose':
          // Prefill only — the /mail composer opens populated; the user sends.
          enqueueLocal(cmd);
          router.push('/mail');
          toast({
            title: 'An agent drafted a message',
            body: 'Review it and send when you’re ready.',
            tone: 'info',
          });
          break;
        default:
          break; // unknown kind (forward-compat) — ignore
      }
    },
    [router, setActiveSpaceId, toast, enqueueLocal],
  );

  /** Drain once (guarded): no overlap, only when visible + workspace + not stopped. */
  const drainOnce = useCallback(async () => {
    if (!activeWorkspaceId || stoppedRef.current || drainingRef.current) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    drainingRef.current = true;
    try {
      const { commands } = await drainUiCommands(activeWorkspaceId);
      // Bound the batch; isolate each apply so one malformed command can't abort the rest.
      for (const cmd of commands.slice(0, MAX_APPLY)) {
        try {
          apply(cmd);
        } catch {
          // swallow — a bad command must never break the cockpit
        }
      }
    } catch (err) {
      // A 401 means the session lapsed — stop rather than hammer a dead session.
      // Every other failure is ambient: swallow it so the cockpit never breaks.
      if (err instanceof ApiError && err.status === 401) stoppedRef.current = true;
    } finally {
      drainingRef.current = false;
    }
  }, [activeWorkspaceId, apply]);

  useEffect(() => {
    // Re-arm whenever the active workspace changes (a fresh org may re-auth).
    stoppedRef.current = false;
    if (!activeWorkspaceId) return;

    // Drain immediately so a freshly-staged command applies without a tick's wait.
    void drainOnce();

    const interval = setInterval(() => void drainOnce(), POLL_INTERVAL);
    const onFocus = () => void drainOnce();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [activeWorkspaceId, drainOnce]);

  return null;
}

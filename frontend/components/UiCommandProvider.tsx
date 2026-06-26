'use client';

/**
 * A tiny hand-off queue for PAGE-LOCAL UI commands (Phase C).
 *
 * Two of the agent UI commands — `open_thread` and `compose` — can only be
 * applied by the `/mail` page (it owns the mail client + the composer), but the
 * `UiCommandBridge` that drains them lives up in `AppShell`. So the bridge stages
 * the command here and `router.push('/mail')`s; the page reads it on mount. This
 * context is the buffer between them.
 *
 * It is mounted ABOVE the routed pages (around `ProductChrome` in `AppShell`), so
 * the queue SURVIVES the `router.push` navigation — the page that mounts AFTER the
 * push can still consume what was staged BEFORE it. Delivery is consume-once:
 * `consumeLocal(kind)` pops the oldest matching command (returns null if none).
 * A `version` counter bumps on every enqueue so a page already mounted on `/mail`
 * can re-check via an effect dependency rather than racing the navigation.
 *
 * The live queue is held in a ref (so a consume reads the latest synchronously,
 * even across several consumes in one tick); `version` is the only reactive bit.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { UiCommandView } from '@/lib/uiCommandsApi';

/** The command kinds the `/mail` page consumes (the only page-local ones). */
export type LocalUiCommandKind = 'open_thread' | 'compose';

/** A page-local command (narrowed to the kinds that get staged here). */
export type LocalUiCommand = Extract<UiCommandView, { kind: LocalUiCommandKind }>;

export interface UiCommandContextValue {
  /** Bumped on every `enqueueLocal` so a mounted page can re-check on change. */
  version: number;
  /** Stage a page-local command (the bridge calls this, then navigates). */
  enqueueLocal: (cmd: LocalUiCommand) => void;
  /** Pop the oldest staged command of `kind` (consume-once), or null if none. */
  consumeLocal: <K extends LocalUiCommandKind>(
    kind: K,
  ) => Extract<LocalUiCommand, { kind: K }> | null;
}

/** Inert default so `useUiCommands` never throws if read outside the provider. */
const DEFAULT_VALUE: UiCommandContextValue = {
  version: 0,
  enqueueLocal: () => {},
  consumeLocal: () => null,
};

const UiCommandContext = createContext<UiCommandContextValue>(DEFAULT_VALUE);

export function UiCommandProvider({ children }: { children: ReactNode }) {
  // The queue lives in a ref: consumes mutate it synchronously (so two consumes
  // in the same tick see each other), while `version` is the only reactive nudge.
  const queueRef = useRef<LocalUiCommand[]>([]);
  const [version, setVersion] = useState(0);

  const enqueueLocal = useCallback((cmd: LocalUiCommand) => {
    queueRef.current = [...queueRef.current, cmd];
    setVersion((v) => v + 1);
  }, []);

  const consumeLocal = useCallback(
    <K extends LocalUiCommandKind>(kind: K): Extract<LocalUiCommand, { kind: K }> | null => {
      const idx = queueRef.current.findIndex((c) => c.kind === kind);
      if (idx === -1) return null;
      const cmd = queueRef.current[idx];
      queueRef.current = [
        ...queueRef.current.slice(0, idx),
        ...queueRef.current.slice(idx + 1),
      ];
      // Safe: matched on `kind`, so the popped command is exactly this kind.
      return cmd as Extract<LocalUiCommand, { kind: K }>;
    },
    [],
  );

  const value = useMemo<UiCommandContextValue>(
    () => ({ version, enqueueLocal, consumeLocal }),
    [version, enqueueLocal, consumeLocal],
  );

  return <UiCommandContext.Provider value={value}>{children}</UiCommandContext.Provider>;
}

/** Read the page-local command queue (safe inert default outside the provider). */
export function useUiCommands(): UiCommandContextValue {
  return useContext(UiCommandContext);
}

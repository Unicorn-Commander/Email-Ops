'use client';

/**
 * Gmail-style keyboard layer for the mail client.
 *
 *   j / k        move the row cursor          Enter / o   open the cursor thread
 *   u            back to the list             e           archive
 *   #            trash                        r / a / f   reply / reply-all / forward
 *   c            compose                      /           focus search
 *   x            toggle select               ⇧I / ⇧U     mark read / unread
 *   ?            shortcuts help
 *
 * Ignored while focus is in an input/textarea/select/contenteditable, while a
 * dialog is open (callers pass `enabled: false`), and for any ⌘/Ctrl/Alt chord.
 */

import { useEffect, useRef } from 'react';

export interface MailShortcutHandlers {
  onMove?: (delta: 1 | -1) => void;
  onOpen?: () => void;
  onBack?: () => void;
  onArchive?: () => void;
  onTrash?: () => void;
  onReply?: () => void;
  onReplyAll?: () => void;
  onForward?: () => void;
  onFocusSearch?: () => void;
  onToggleSelect?: () => void;
  onMarkRead?: () => void;
  onMarkUnread?: () => void;
  onCompose?: () => void;
  onHelp?: () => void;
}

function inEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function useMailShortcuts(handlers: MailShortcutHandlers, enabled: boolean) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!enabledRef.current) return;
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (inEditable(e.target)) return;

      const h = handlersRef.current;
      let handled = true;
      switch (e.key) {
        case 'j':
          h.onMove?.(1);
          break;
        case 'k':
          h.onMove?.(-1);
          break;
        case 'Enter':
        case 'o':
          h.onOpen?.();
          break;
        case 'u':
          h.onBack?.();
          break;
        case 'e':
          h.onArchive?.();
          break;
        case '#':
          h.onTrash?.();
          break;
        case 'r':
          h.onReply?.();
          break;
        case 'a':
          h.onReplyAll?.();
          break;
        case 'f':
          h.onForward?.();
          break;
        case 'c':
          h.onCompose?.();
          break;
        case '/':
          h.onFocusSearch?.();
          break;
        case 'x':
          h.onToggleSelect?.();
          break;
        case 'I':
          h.onMarkRead?.();
          break;
        case 'U':
          h.onMarkUnread?.();
          break;
        case '?':
          h.onHelp?.();
          break;
        default:
          handled = false;
      }
      if (handled) e.preventDefault();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

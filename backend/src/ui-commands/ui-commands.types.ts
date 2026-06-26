/**
 * Wire types for the "agent controls the UI" surface. An agent (MCP client)
 * enqueues a UiCommand for a (workspaceId, ucUid); the user's cockpit drains it.
 * Wire JSON is snake_case; the payload shape is per-kind (see the contract).
 */

import { UiCommandKind } from '@prisma/client';

export type UiCommandKindWire = 'navigate' | 'open_thread' | 'compose' | 'switch_space' | 'notify';

/** One command as delivered to the browser by the drain endpoint. */
export interface UiCommandView {
  id: string;
  kind: UiCommandKindWire;
  payload: Record<string, unknown>;
  created_at: string;
}

export function kindToWire(kind: UiCommandKind): UiCommandKindWire {
  switch (kind) {
    case UiCommandKind.NAVIGATE:
      return 'navigate';
    case UiCommandKind.OPEN_THREAD:
      return 'open_thread';
    case UiCommandKind.COMPOSE:
      return 'compose';
    case UiCommandKind.SWITCH_SPACE:
      return 'switch_space';
    case UiCommandKind.NOTIFY:
      return 'notify';
  }
}

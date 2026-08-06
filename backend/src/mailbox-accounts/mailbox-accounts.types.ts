/**
 * MailboxAccount management types — the net-new CRUD over the workspace's
 * mailboxes (human / agent / shared principals). The send/transport fields stay
 * as today; this adds the ownership + provision-state surface.
 */

import { MailboxOwnerKind, MailboxProvisionState } from '@prisma/client';

export interface MailboxView {
  id: string;
  email_address: string;
  display_name: string | null;
  owner_kind: MailboxOwnerKind;
  owner_key: string | null;
  kind: string;
  /** The mail backend: 'stalwart' (sovereign) | 'gmail' | 'microsoft' (external). */
  provider: string;
  provision_state: MailboxProvisionState;
  is_default: boolean;
  postmark_lane: boolean;
  active: boolean;
  /** How many agents are bound to this mailbox (AgentMailbox). */
  agent_count: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface CreateMailboxInput {
  emailAddress: string;
  displayName?: string | null;
  ownerKind?: MailboxOwnerKind;
  ownerKey?: string | null;
  postmarkLane?: boolean;
}

export interface UpdateMailboxInput {
  displayName?: string | null;
  ownerKind?: MailboxOwnerKind;
  ownerKey?: string | null;
  postmarkLane?: boolean;
  active?: boolean;
}

/**
 * Wire shapes for the mail-triage surface (folder dispositions + sender policy).
 * snake_case field names mirror the rest of the Email-Ops wire contract.
 */

import { MessageDisposition, SenderPolicyKind, SenderPolicyScope } from '@prisma/client';

/** A thread's folder placement (the overlay row, view form). */
export interface DispositionView {
  thread_id: string;
  disposition: MessageDisposition;
  set_by_uc_uid: string | null;
  set_by_agent_key: string | null;
  updated_at: string;
}

/** One sender block/allow rule. */
export interface SenderPolicyView {
  id: string;
  scope: SenderPolicyScope;
  pattern: string;
  kind: SenderPolicyKind;
  reason: string | null;
  set_by_uc_uid: string | null;
  set_by_agent_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface SetSenderPolicyInput {
  scope: SenderPolicyScope;
  pattern: string;
  kind: SenderPolicyKind;
  reason?: string | null;
  /** Provenance when an agent (not a human) files the rule. */
  agentKey?: string | null;
}

/** The result of classifying a received thread (the inbound-pipeline seam). */
export interface ClassifyResult {
  thread_id: string;
  disposition: MessageDisposition;
  spam_score: number | null;
  spam_verdict: 'clean' | 'spam' | 'unsure' | null;
  /** Why this disposition was chosen (audit/debug). */
  reason:
    | 'sender_allowed'
    | 'sender_blocked'
    | 'engine_verdict'
    | 'engine_clean'
    | 'engine_dormant';
}

import { plainTextBodySha256 } from '../email/agent-send-kit';

export interface ApprovalFeedback {
  sentBodySha256: string;
  editedBeforeSend: boolean | null;
  factualCorrection: boolean | null;
}

/** Use the same exact UTF-8 hash as the draft; never reconstruct a missing baseline. */
export function approvalFeedback(
  bodySha256: string | null | undefined,
  sentBody: string,
  factualCorrection?: boolean | null,
): ApprovalFeedback {
  const sentBodySha256 = plainTextBodySha256(sentBody);
  return {
    sentBodySha256,
    editedBeforeSend: bodySha256 == null ? null : bodySha256 !== sentBodySha256,
    factualCorrection: factualCorrection ?? null,
  };
}

/** Approval events have a text detail column; store a self-contained JSON snapshot. */
export function approvalAuditDetail(
  subject: string | null,
  bodySha256: string | null | undefined,
  feedback: ApprovalFeedback,
  note?: string | null,
  sendAt?: Date,
): string {
  return JSON.stringify({
    subject,
    body_sha256: bodySha256 ?? null,
    sent_body_sha256: feedback.sentBodySha256,
    edited_before_send: feedback.editedBeforeSend,
    factual_correction: feedback.factualCorrection,
    review_note: note ?? null,
    ...(sendAt ? { sends_at: sendAt.toISOString() } : {}),
  });
}

import { plainTextBodySha256 } from '../email/agent-send-kit';

export interface ApprovalFeedback {
  sentBodySha256: string;
  editedBeforeSend: boolean | null;
  factualCorrection: boolean | null;
}

/**
 * Compare text after trimming and collapsing all Unicode whitespace runs. This
 * makes line-ending and formatting-only changes honest non-edits while keeping
 * sent_body_sha256 as the exact UTF-8 hash of the text delivered.
 */
export function normalizeApprovalText(body: string): string {
  return body.replace(/\s+/gu, ' ').trim();
}

/** Hash the exact sent text; never reconstruct a missing draft baseline. */
export function approvalFeedback(
  bodySha256: string | null | undefined,
  sentBody: string,
  factualCorrection?: boolean | null,
  draftBody?: string | null,
): ApprovalFeedback {
  const sentBodySha256 = plainTextBodySha256(sentBody);
  return {
    sentBodySha256,
    editedBeforeSend:
      bodySha256 == null
        ? null
        : draftBody == null
          ? bodySha256 !== sentBodySha256
          : normalizeApprovalText(draftBody) !== normalizeApprovalText(sentBody),
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

"use client";

import { useCallback, useEffect, useState } from "react";
import { useActiveWorkspace } from "@/components/ActiveWorkspaceProvider";
import { Button, Card } from "@/components/ui";
import { listMailboxes, MailboxView } from "@/lib/mailboxApi";
import {
  listStandingApprovals,
  revokeStandingApproval,
  StandingApproval,
} from "@/lib/approvalsApi";
import { StandingApprovalForm } from "./StandingApprovalForm";

export function StandingApprovals() {
  const { activeWorkspace } = useActiveWorkspace();
  const workspace = activeWorkspace?.workspace_id;
  const [items, setItems] = useState<StandingApproval[]>([]);
  const [mailboxes, setMailboxes] = useState<MailboxView[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const refresh = useCallback(async () => {
    if (!workspace) return;
    try {
      const [approvals, boxes] = await Promise.all([
        listStandingApprovals(workspace),
        listMailboxes(workspace),
      ]);
      setItems(approvals.items);
      setMailboxes(boxes.items);
      setError("");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to load campaign approvals.",
      );
    }
  }, [workspace]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function revoke(id: string) {
    if (!workspace) return;
    setBusy(true);
    setError("");
    try {
      await revokeStandingApproval(workspace, id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to revoke.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card padded className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Standing campaign approvals</h2>
        <Button variant="secondary" onClick={() => setShowForm(!showForm)}>
          New campaign approval
        </Button>
      </div>
      <p className="text-sm text-tertiary">
        Approve a template, sender and daily limit for up to 90 days. New
        batches can then send within those limits.
      </p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {showForm && workspace && (
        <StandingApprovalForm
          workspace={workspace}
          mailboxes={mailboxes}
          onCreated={async (approvalUrl) => {
            if (approvalUrl) window.location.assign(approvalUrl);
            else await refresh();
          }}
        />
      )}
      {items.length === 0 && !error && (
        <p className="text-sm text-muted">No campaign approvals yet.</p>
      )}
      {items.map((item) => {
        const state = item.revokedAt
          ? "Revoked"
          : new Date(item.expiresAt) <= new Date()
            ? "Expired"
            : item.approvedAt
              ? "Active"
              : "Pending review";
        return (
          <div
            key={item.id}
            className="flex flex-wrap items-center justify-between gap-3 border-t border-subtle pt-3 text-sm"
          >
            <div className="min-w-0">
              <p className="font-medium">
                {item.campaignKey} · {state}
              </p>
              {!item.approvedAt && !item.revokedAt && item.requestedBy && (
                <p className="font-medium">Requested by {item.requestedBy}</p>
              )}
              <p className="break-all text-tertiary">
                {item.fromAddress} · {item.usedToday}/{item.capPerDay} daily
                reservations · expires{" "}
                {new Date(item.expiresAt).toLocaleDateString()}
              </p>
            </div>
            <div className="flex gap-2">
              {item.approval_url && (
                <a className="text-accent underline" href={item.approval_url}>
                  Review approval
                </a>
              )}
              {!item.revokedAt && (
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void revoke(item.id)}
                >
                  Revoke
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </Card>
  );
}

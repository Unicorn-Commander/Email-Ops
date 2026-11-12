"use client";

import { useId, useState } from "react";
import { Button } from "../ui";
import {
  disconnectExternalImap,
  type ExternalImapDisconnectResponse,
} from "../../lib/mailApi";

export function ExternalImapDisconnect({
  workspaceId,
  mailboxId,
  onDisconnected,
}: {
  workspaceId: string;
  mailboxId: string;
  onDisconnected: () => void;
}) {
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExternalImapDisconnectResponse | null>(
    null,
  );

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const next = await disconnectExternalImap(workspaceId, mailboxId);
      setResult(next);
      setOpen(false);
      window.dispatchEvent(new CustomEvent('external-imap:disconnected', { detail: workspaceId }));
      onDisconnected();
    } catch {
      setError("Could not disconnect this mailbox. Nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-w-0" onClick={(event) => event.stopPropagation()}>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        title="Disconnect this external IMAP mailbox"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {busy ? "Disconnecting..." : "Disconnect"}
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) {
              setError(null);
              setOpen(false);
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="w-full max-w-md rounded-token-lg border border-border bg-surface-elevated text-secondary shadow-token-lg"
          >
            <div className="space-y-3 p-5">
              <h2 id={titleId} className="text-base font-semibold text-primary">
                Disconnect external IMAP mailbox?
              </h2>
              <p className="text-sm text-tertiary">
                This wipes the stored app password and marks the mailbox
                inactive. Your mail stays at the provider.
              </p>
              <p className="text-sm text-secondary">
                Email-Ops does not delete messages or history. To reconnect
                later, enter a new app password from the provider.
              </p>
              {error ? (
                <p role="alert" className="text-xs leading-5 text-danger">
                  {error}
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-subtle p-4">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setError(null);
                  setOpen(false);
                }}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => void confirm()}
                disabled={busy}
              >
                {busy ? "Disconnecting..." : "Disconnect IMAP"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {result ? (
        <p role="status" className="mt-1 text-[11px] leading-4 text-secondary">
          External IMAP mailbox disconnected. The stored credential was{" "}
          {result.credential === "already_absent" ? "already wiped" : "wiped"},
          and mail at the provider was not deleted.
        </p>
      ) : null}
    </div>
  );
}

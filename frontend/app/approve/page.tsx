"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, apiPost } from "@/lib/api";
import {
  approvalAction,
  ApprovalLocation,
  ApprovalPreview,
} from "@/lib/approvalsApi";
import { Button, Card } from "@/components/ui";

export default function ApprovePage() {
  const router = useRouter();
  const [location, setLocation] = useState<ApprovalLocation | null>(null);
  const [preview, setPreview] = useState<ApprovalPreview | null>(null);
  const [error, setError] = useState("");
  const [needsLogin, setNeedsLogin] = useState(false);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [forgotten, setForgotten] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams(window.location.hash.slice(1));
    const value = {
      workspace: params.get("workspace") || "",
      kind: params.get("kind") || "",
      id: params.get("id") || "",
      token: params.get("token") || "",
    };
    if (
      !value.workspace ||
      !value.id ||
      !value.token ||
      !["send-kit", "standing"].includes(value.kind)
    ) {
      setError(
        "This approval link is incomplete. Open the latest link from your inbox.",
      );
      return;
    }
    setLocation(value);
    approvalAction<ApprovalPreview>(value, "preview")
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((err) => {
        if (cancelled) return;
        setNeedsLogin(err instanceof ApiError && err.status === 401);
        setError(
          err instanceof Error ? err.message : "Unable to open this approval.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function signIn() {
    window.sessionStorage.setItem(
      "email-ops:approval-return",
      `/approve${window.location.hash}`,
    );
    router.push("/auth/login");
  }

  async function approve() {
    if (!location || busy) return;
    setBusy(true);
    setError("");
    try {
      await approvalAction(location, "approve", remember);
      setDone(true);
      window.history.replaceState(null, "", "/approve");
    } catch (err) {
      setNeedsLogin(err instanceof ApiError && err.status === 401);
      setError(err instanceof Error ? err.message : "Unable to approve.");
    } finally {
      setBusy(false);
    }
  }

  async function forget() {
    if (!location) return;
    setBusy(true);
    setError("");
    try {
      await apiPost(
        `/approvals/${encodeURIComponent(location.workspace)}/session/forget`,
        {},
        undefined,
        { "X-Email-Ops-Approval": "1" },
      );
      setForgotten(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to forget this phone.",
      );
    } finally {
      setBusy(false);
    }
  }

  const target = preview?.kit ?? preview?.standing;
  const standing = preview?.standing;
  return (
    <main className="min-h-screen bg-surface-base px-4 py-8 text-primary">
      <Card padded className="mx-auto max-w-xl space-y-5">
        <p className="text-sm text-tertiary">Email-Ops · Human approval</p>
        <h1 className="text-2xl font-semibold">
          {done
            ? "Approved"
            : standing
              ? "Approve this campaign"
              : "Review send kit"}
        </h1>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {needsLogin && (
          <>
            <p>
              Sign in to review and approve. This link alone cannot approve
              anything.
            </p>
            <Button block onClick={signIn}>
              Sign in
            </Button>
          </>
        )}
        {!target && !error && <p role="status">Loading approval…</p>}
        {target && !done && (
          <>
            <h2 className="text-lg font-medium">
              {preview?.kit?.title ?? standing?.campaignKey}
            </h2>
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-tertiary">Sender</dt>
                <dd className="break-all">{target.fromAddress}</dd>
              </div>
              <div>
                <dt className="text-tertiary">Daily limit</dt>
                <dd>
                  {target.capPerDay} sends · America/New_York calendar day
                </dd>
              </div>
              <div>
                <dt className="text-tertiary">Approval expires</dt>
                <dd>{new Date(target.expiresAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt className="text-tertiary">Subject</dt>
                <dd>{target.subjects.join(" / ")}</dd>
              </div>
            </dl>
            <pre className="whitespace-pre-wrap break-words rounded-token-md bg-surface-base p-4 text-sm">
              {target.bodyTemplate}
            </pre>
            {preview?.kit && (
              <details>
                <summary className="cursor-pointer">
                  Recipients ({preview.kit.recipientHashes.length})
                </summary>
                <ul className="mt-2 max-h-64 overflow-auto text-sm">
                  {preview.kit.recipients.map((recipient) => (
                    <li className="break-all" key={recipient}>
                      {recipient}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {standing && (
              <div className="text-sm space-y-2">
                <p>
                  New recipients matching these rules may be sent this template
                  without another approval.
                </p>
                <p>
                  Allowed domains:{" "}
                  {standing.recipientRules.allowedDomains.join(", ") || "Any"}
                </p>
                <p>
                  Blocked domains:{" "}
                  {standing.recipientRules.blockedDomains.join(", ") || "None"}
                </p>
                <p>
                  Approving replaces any active approval for this campaign. You
                  can revoke it from the agent inbox.
                </p>
              </div>
            )}
            <details className="text-sm">
              <summary className="cursor-pointer">
                Template and personalization details
              </summary>
              <p className="mt-2 break-all font-mono text-xs">
                SHA-256: {target.templateSha256}
              </p>
              <pre className="whitespace-pre-wrap break-all text-xs">
                {JSON.stringify(
                  {
                    placeholders: target.placeholderRules,
                    optionalLines: target.optionalLines,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
            {preview?.canRemember && (
              <label className="flex gap-3 text-sm items-start">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                <span>
                  Keep me signed in for approvals on this phone for 30 days.
                  This session can only review and approve links in this
                  workspace.
                </span>
              </label>
            )}
            <Button
              block
              disabled={busy || needsLogin}
              onClick={() => void approve()}
            >
              {busy
                ? "Approving…"
                : standing
                  ? "Approve campaign"
                  : "Approve send kit"}
            </Button>
          </>
        )}
        {done && (
          <p role="status">
            {standing
              ? "This campaign is approved within the limits you reviewed."
              : "This send kit is approved for the recipients you reviewed."}
          </p>
        )}
        {target &&
          (!preview?.canRemember || (done && remember)) &&
          !forgotten && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => void forget()}
            >
              Forget approvals on this phone
            </Button>
          )}
        {forgotten && (
          <p role="status">
            The approval session on this phone has been removed.
          </p>
        )}
      </Card>
    </main>
  );
}

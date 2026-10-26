"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Card, Dialog, Input, Select } from "@/components/ui";
import { ApiError } from "@/lib/api";
import {
  createCalendarDevice,
  listCalendarDevices,
  revokeCalendarDevice,
  type CalendarDevice,
  type CalendarDeviceSecret,
} from "@/lib/calendarApi";
import type { MailboxView } from "@/lib/mailboxApi";

interface CalendarDevicesPanelProps {
  workspaceId: string | null;
  mailboxes: MailboxView[];
  unavailable?: boolean;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "The calendar device-key operation failed.";
}

function expiryLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "expiry unavailable"
    : `expires ${new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(date)}`;
}

function statusBadge(device: CalendarDevice) {
  if (device.status === "revoked")
    return <Badge variant="neutral">Revoked</Badge>;
  if (device.status === "expired")
    return <Badge variant="warning">Expired</Badge>;
  return <Badge variant="protected">Active</Badge>;
}

export function CalendarDevicesPanel({
  workspaceId,
  mailboxes,
  unavailable = false,
}: CalendarDevicesPanelProps) {
  const [mailboxId, setMailboxId] = useState("");
  const [label, setLabel] = useState("");
  const [devices, setDevices] = useState<CalendarDevice[]>([]);
  const [oneTime, setOneTime] = useState<CalendarDeviceSecret | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMailboxId((current) =>
      mailboxes.some((mailbox) => mailbox.id === current)
        ? current
        : (mailboxes[0]?.id ?? ""),
    );
  }, [mailboxes]);

  useEffect(() => {
    if (!workspaceId || !mailboxId || unavailable) {
      setDevices([]);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    void listCalendarDevices(workspaceId, mailboxId)
      .then((result) => {
        if (alive) setDevices(result.items);
      })
      .catch((loadError: unknown) => {
        if (alive) setError(errorMessage(loadError));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [workspaceId, mailboxId, unavailable]);

  const addDevice = async () => {
    if (!workspaceId || !mailboxId || !label.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const created = await createCalendarDevice(workspaceId, {
        mailboxId,
        label: label.trim(),
      });
      const metadata: CalendarDevice = {
        id: created.id,
        mailbox_id: created.mailbox_id,
        label: created.label,
        davis_app_id: created.davis_app_id,
        created_at: created.created_at,
        expires_at: created.expires_at,
        revoked_at: created.revoked_at,
        status: created.status,
      };
      setDevices((current) => [metadata, ...current]);
      setLabel("");
      // The secret lives only in this in-memory dialog state. onOpenChange
      // clears it on Done, Escape, or an outside click.
      setOneTime(created);
    } catch (createError) {
      setError(errorMessage(createError));
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (device: CalendarDevice) => {
    if (!workspaceId || device.status === "revoked") return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(`Revoke the “${device.label}” calendar key?`)
    )
      return;
    setRevokingId(device.id);
    setError(null);
    try {
      const result = await revokeCalendarDevice(workspaceId, device.id);
      setDevices((current) =>
        current.map((item) => (item.id === device.id ? result.device : item)),
      );
    } catch (revokeError) {
      // Keep the row unchanged and visible when Davis did not confirm.
      setError(errorMessage(revokeError));
    } finally {
      setRevokingId(null);
    }
  };

  const closeOneTime = (open: boolean) => {
    if (!open) setOneTime(null);
  };

  return (
    <>
      <Card className="overflow-hidden">
        <div className="border-b border-subtle p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="accent" dot>
                  Devices
                </Badge>
                <span className="text-xs text-muted">
                  Per-device CalDAV access
                </span>
              </div>
              <h2 className="mt-2 text-lg font-semibold text-primary">
                Calendar devices
              </h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-tertiary">
                Create a separate revocable key for each phone or desktop
                calendar client. Davis shows each secret once.
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-4 p-4 sm:p-5">
          {error && (
            <p
              role="alert"
              className="rounded-token border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger"
            >
              {error}
            </p>
          )}
          {unavailable ? (
            <p className="text-sm text-tertiary">
              Device keys are unavailable while the calendar is in fictional
              demo mode.
            </p>
          ) : mailboxes.length === 0 ? (
            <p className="text-sm text-tertiary">
              Add an active Davis-backed mailbox before creating a device key.
            </p>
          ) : (
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end">
              <div>
                <label
                  htmlFor="calendar-device-mailbox"
                  className="mb-1.5 block text-xs font-semibold text-tertiary"
                >
                  Mailbox
                </label>
                <Select
                  id="calendar-device-mailbox"
                  value={mailboxId}
                  onChange={(event) => setMailboxId(event.target.value)}
                >
                  {mailboxes.map((mailbox) => (
                    <option key={mailbox.id} value={mailbox.id}>
                      {mailbox.email_address}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <label
                  htmlFor="calendar-device-label"
                  className="mb-1.5 block text-xs font-semibold text-tertiary"
                >
                  Device label
                </label>
                <Input
                  id="calendar-device-label"
                  value={label}
                  maxLength={64}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder="iPhone · Aaron"
                  autoComplete="off"
                />
              </div>
              <Button
                onClick={() => void addDevice()}
                disabled={saving || !mailboxId || !label.trim()}
              >
                {saving ? "Creating…" : "Create key"}
              </Button>
            </div>
          )}

          {!unavailable &&
            mailboxId &&
            (loading ? (
              <p className="text-sm text-muted" role="status">
                Loading device keys…
              </p>
            ) : devices.length === 0 ? (
              <div className="rounded-token border border-dashed border-border p-5 text-center text-sm text-muted">
                No device keys for this mailbox.
              </div>
            ) : (
              <div className="divide-y divide-subtle rounded-token border border-border">
                {devices.map((device) => {
                  const mailbox = mailboxes.find(
                    (item) => item.id === device.mailbox_id,
                  );
                  return (
                    <div
                      key={device.id}
                      className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-semibold text-primary">
                            {device.label}
                          </p>
                          {statusBadge(device)}
                        </div>
                        <p className="mt-1 truncate text-xs text-tertiary">
                          {mailbox?.email_address ?? "Mailbox"} ·{" "}
                          {expiryLabel(device.expires_at)}
                        </p>
                      </div>
                      {device.status !== "revoked" && (
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => void revoke(device)}
                          disabled={revokingId === device.id}
                        >
                          {revokingId === device.id ? "Revoking…" : "Revoke"}
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
        </div>
      </Card>

      <Dialog
        open={oneTime !== null}
        onOpenChange={closeOneTime}
        title="Save this calendar key now"
        description="The secret is shown once and disappears when this dialog closes. It is not stored in the browser."
        className="max-w-xl"
        footer={
          <Button onClick={() => setOneTime(null)}>Done — I saved it</Button>
        }
      >
        {oneTime && <OneTimeKeyDetails device={oneTime} />}
      </Dialog>
    </>
  );
}

function OneTimeKeyDetails({ device }: { device: CalendarDeviceSecret }) {
  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-token border border-accent/30 bg-accent/5 p-4">
        <CredentialField label="Server" value={device.server_url} />
        <CredentialField label="Username" value={device.username} />
        <CredentialField label="Secret" value={device.secret} secret />
      </div>
      <div className="space-y-3 text-sm text-secondary">
        <div>
          <p className="font-semibold text-primary">iPhone or iPad</p>
          <p className="mt-1 leading-6">
            Settings → Apps → Calendar → Calendar Accounts → Add Account → Other
            → Add CalDAV Account. Enter the server, username, and secret, then
            confirm the calendar appears.
          </p>
        </div>
        <div>
          <p className="font-semibold text-primary">Android with DAVx5</p>
          <p className="mt-1 leading-6">
            Choose + → Login with URL and user name. Enter the server URL,
            username, and secret, enable the calendar collection, and confirm a
            harmless test event syncs.
          </p>
        </div>
      </div>
      <p className="text-xs leading-5 text-muted">
        If the secret is lost, revoke this key and create a replacement. Never
        paste it into chat, tickets, or screenshots.
      </p>
    </div>
  );
}

function CredentialField({
  label,
  value,
  secret = false,
}: {
  label: string;
  value: string;
  secret?: boolean;
}) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-tertiary">
        {label}
      </p>
      <code
        aria-label={`${label} value`}
        className="block select-all break-all rounded-token border border-border bg-surface-base px-3 py-2 font-mono text-xs text-primary"
      >
        {secret ? value : value}
      </code>
    </div>
  );
}

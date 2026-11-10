"use client";

import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Button, Input, Select } from "@/components/ui";
import type { MailboxView } from "@/lib/mailboxApi";
import { requestStandingApproval } from "@/lib/approvalsApi";
import {
  PLACEHOLDER_PRESETS,
  detectPlaceholders,
  isValidPlaceholderRule,
  missingPlaceholderMessage,
  presetIdFor,
  syncPlaceholderRules,
} from "./placeholder-rules";

const FREE_MAIL_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "aol.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
];

export function StandingApprovalForm({
  workspace,
  mailboxes,
  onCreated,
  submitRequest = requestStandingApproval,
}: {
  workspace: string;
  mailboxes: MailboxView[];
  onCreated: (approvalUrl: string | null) => Promise<void> | void;
  submitRequest?: typeof requestStandingApproval;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [blockFreeMail, setBlockFreeMail] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [rules, setRules] = useState<Record<string, string>>({});
  const placeholderNames = useMemo(
    () => detectPlaceholders(`${subject}\n${body}`),
    [subject, body],
  );
  useEffect(() => {
    setRules((current) => syncPlaceholderRules(current, placeholderNames));
  }, [placeholderNames]);
  const missingRules = placeholderNames.filter((name) => !rules[name]?.trim());
  const invalidRules = placeholderNames.filter(
    (name) => !!rules[name]?.trim() && !isValidPlaceholderRule(rules[name]),
  );
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    const domains = (key: string) =>
      String(form.get(key) || "")
        .split(",")
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
    const names = detectPlaceholders(`${subject}\n${body}`);
    const missing = names.find((name) => !rules[name]?.trim());
    if (missing) {
      setError(missingPlaceholderMessage(missing));
      setBusy(false);
      return;
    }
    const invalid = names.find((name) => !isValidPlaceholderRule(rules[name]));
    if (invalid) {
      setError(`placeholder_rules.${invalid} is not a valid regular expression.`);
      setBusy(false);
      return;
    }
    const placeholderRules: Record<string, string> = {};
    for (const name of names) placeholderRules[name] = rules[name];
    try {
      const result = await submitRequest(workspace, {
        campaign_key: String(form.get("campaign")),
        mailbox_id: String(form.get("mailbox")),
        subject,
        body_template: body,
        ...(names.length ? { placeholder_rules: placeholderRules } : {}),
        cap_per_day: Number(form.get("cap")),
        expires_at: new Date(String(form.get("expiry"))).toISOString(),
        recipient_rules: {
          allowedDomains: domains("allowed"),
          blockedDomains: [
            ...new Set([
              ...domains("blocked"),
              ...(blockFreeMail ? FREE_MAIL_DOMAINS : []),
            ]),
          ],
        },
      });
      await onCreated(result.approval_url);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to create campaign request.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <form onSubmit={create} className="grid gap-3 text-sm">
        <label>
          Campaign name
          <Input name="campaign" required maxLength={200} />
        </label>
        <label>
          Sender mailbox
          <select
            name="mailbox"
            required
            className="mt-1 w-full rounded-token-md border border-subtle bg-surface-base p-2"
          >
            {mailboxes
              .filter((box) => box.active)
              .map((box) => (
                <option key={box.id} value={box.id}>
                  {box.email_address}
                </option>
              ))}
          </select>
        </label>
        <label>
          Subject
          <Input
            name="subject"
            required
            maxLength={500}
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
          />
        </label>
        <label>
          Plain text template
          <textarea
            name="body"
            required
            maxLength={100000}
            rows={8}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            className="mt-1 w-full rounded-token-md border border-subtle bg-surface-base p-3"
          />
        </label>
        <p className="text-xs text-muted">
          Write {"{name}"} where a value changes per recipient. Each name
          needs a regular expression. {"{first_name}"} starts as a required
          non-empty name, and {"{token}"} starts as 16 lowercase hex
          characters.
        </p>
        {placeholderNames.length > 0 && (
          <fieldset className="grid gap-3">
            <legend className="font-medium">Placeholder rules</legend>
            {placeholderNames.map((name) => {
              const rule = rules[name] ?? "";
              const missing = !rule.trim();
              const invalid = !missing && !isValidPlaceholderRule(rule);
              return (
                <div key={name} className="grid gap-2">
                  <span className="font-mono text-xs">{`{${name}}`}</span>
                  <Select
                    aria-label={`Rule kind for ${name}`}
                    value={presetIdFor(rule)}
                    onChange={(event) => {
                      const id = event.target.value;
                      if (id === "custom") {
                        setRules((current) => ({ ...current, [name]: "" }));
                        return;
                      }
                      const preset = PLACEHOLDER_PRESETS.find((item) => item.id === id);
                      if (preset) {
                        setRules((current) => ({ ...current, [name]: preset.rule }));
                      }
                    }}
                  >
                    {PLACEHOLDER_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                    <option value="custom">Custom regular expression</option>
                  </Select>
                  <Input
                    aria-label={`Regular expression for ${name}`}
                    value={rule}
                    spellCheck={false}
                    invalid={missing || invalid}
                    onChange={(event) =>
                      setRules((current) => ({ ...current, [name]: event.target.value }))
                    }
                  />
                  {missing && (
                    <p role="alert" className="text-xs text-danger">
                      {missingPlaceholderMessage(name)}
                    </p>
                  )}
                  {invalid && (
                    <p role="alert" className="text-xs text-danger">
                      placeholder_rules.{name} is not a valid regular expression.
                    </p>
                  )}
                </div>
              );
            })}
          </fieldset>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label>
            Daily send cap
            <Input
              name="cap"
              type="number"
              min={1}
              max={100000}
              defaultValue={25}
              required
            />
          </label>
          <label>
            Expires at
            <Input name="expiry" type="datetime-local" required />
          </label>
        </div>
        <label>
          Only these recipient domains (optional)
          <Input name="allowed" placeholder="example.com, example.org" />
        </label>
        <label>
          Blocked recipient domains (optional)
          <Input name="blocked" placeholder="example.net" />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={blockFreeMail}
            onChange={(event) => setBlockFreeMail(event.target.checked)}
          />
          Block common free-mail domains
        </label>
        {blockFreeMail && (
          <p className="break-words text-xs text-tertiary">
            {FREE_MAIL_DOMAINS.join(", ")}. Add any others above.
          </p>
        )}
        <Button
          type="submit"
          disabled={busy || missingRules.length > 0 || invalidRules.length > 0}
        >
          {busy ? "Saving…" : "Review campaign approval"}
        </Button>
      </form>
    </>
  );
}

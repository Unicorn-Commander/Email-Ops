'use client';

/**
 * The command-center Help dialog (opened by the top-bar "?" button or the `?`
 * keyboard shortcut). A proper, discoverable guide to the Agent Email Command
 * Center — how the agent rail + its metrics work, the autonomy dial, agent-draft
 * approval, folders/triage, All-inboxes, connecting via MCP — plus the full
 * keyboard-shortcut reference. Calm-Control, theme-aware, accessible (Radix
 * Dialog: focus trap + Escape). Content-rich but not gaudy.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Dialog } from '@/components/ui';

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'Navigate',
    rows: [
      ['j / k', 'Next / previous conversation'],
      ['Enter or o', 'Open conversation'],
      ['u', 'Back to list'],
      ['/', 'Focus search'],
      ['⌘K', 'Command menu'],
    ],
  },
  {
    title: 'Triage',
    rows: [
      ['e', 'Archive'],
      ['#', 'Trash'],
      ['x', 'Select conversation'],
      ['⇧I / ⇧U', 'Mark read / unread'],
    ],
  },
  {
    title: 'Compose',
    rows: [
      ['c', 'Compose'],
      ['r', 'Reply'],
      ['a', 'Reply all'],
      ['f', 'Forward'],
    ],
  },
  {
    title: 'General',
    rows: [['?', 'Open this help']],
  },
];

function Key({ children }: { children: string }) {
  return (
    <kbd className="inline-flex min-w-[18px] items-center justify-center rounded-[5px] border border-border bg-surface-overlay px-1.5 py-px text-[11px] leading-none text-secondary mono">
      {children}
    </kbd>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-[13px] font-semibold text-primary">{title}</h3>
      <div className="space-y-1.5 text-[12px] leading-6 text-secondary">{children}</div>
    </section>
  );
}

function Row({ label, dot, children }: { label: string; dot?: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      {dot && <span aria-hidden className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />}
      <p>
        <b className="text-primary">{label}</b> — {children}
      </p>
    </div>
  );
}

export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title="Email-Ops — help"
      description="Your agent email command center: agents draft, triage, and (with permission) send; you stay in control. Press ? anytime to reopen this."
      className="max-w-2xl"
    >
      <div className="max-h-[70vh] space-y-6 overflow-y-auto pr-1">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-token border border-accent/30 bg-accent/[0.06] px-3.5 py-2.5">
          <p className="text-[12px] leading-5 text-secondary">
            This is the quick reference. The <b className="text-primary">full manual</b> — every
            feature, the autonomy matrix, trust, cleanup, troubleshooting — lives on the Help
            page.
          </p>
          <Link
            href="/help"
            onClick={onClose}
            className="shrink-0 text-[12px] font-semibold text-accent hover:underline"
          >
            Open the full guide →
          </Link>
        </div>

        <Section title="The agent activity rail & its metrics">
          <p className="text-tertiary">
            The right rail is a live timeline of what the fleet did with mail. Toggle
            it from the robot button in the top bar; collapsed it becomes a slim
            strip that still shows a pending-approval badge and pulses when
            approvals wait. Its three metrics are honest server-side counts (last 7
            days), not guesses:
          </p>
          <Row label="Triaged" dot="bg-accent">
            distinct threads an <em>agent</em> filed into a folder. Your own triage
            isn&rsquo;t counted — this is the agents&rsquo; work.
          </Row>
          <Row label="Sent" dot="bg-info">
            agent sends: autonomous (L2) sends plus drafts you approved that went out.
          </Row>
          <Row label="Awaiting" dot="bg-warning">
            agent drafts pending your approval right now — matches the Agent Inbox
            badge, live.
          </Row>
        </Section>

        <Section title="The autonomy dial (per agent)">
          <p className="text-tertiary">
            The dial at the rail&rsquo;s foot sets how far one agent can go in the
            send path:
          </p>
          <Row label="L0 · Draft only">composes and stages, never sends.</Row>
          <Row label="L1 · Approve to send">
            stages a draft; it only sends after you approve (the default).
          </Row>
          <Row label="L2 · Autonomous, with audit">
            may send on its own — every send is logged in the rail, nothing is silent.
          </Row>
          <p className="text-tertiary">
            The <b>Pause all agents</b> pill in the top bar is a global kill switch
            that overrides every level at once (drafts you already approved still send).
          </p>
        </Section>

        <Section title="Agent-draft cards & approving">
          <p className="text-tertiary">
            When an agent stages a reply it appears in the rail with a <b>Review</b>{' '}
            action and in the <b>Agent Inbox</b> queue. There each card shows who
            drafted it, the recipient, and a preview: <b>Approve &amp; send</b> hands
            it to the send lane; <b>Reject</b> means it never leaves. Every decision
            is attributed for audit.
          </p>
        </Section>

        <Section title="Reading: pop-out, folders & senders">
          <p className="text-tertiary">
            Open a conversation to read it inline, or <b>pop it out</b> into an
            overlay — and eject that overlay into its own window to keep it beside
            your inbox. Triage from the reader: <b>Archive</b> (kept, out of inbox),
            <b>Spam</b> (files it and blocks the sender), <b>Trash</b> (reversible).
            From Spam, <b>Not spam</b> restores it and trusts the sender. Manage the
            full block/allow list under <b>Manage senders</b>. Permanent purge stays
            gated behind a downloadable backup.
          </p>
        </Section>

        <Section title="All inboxes & Spaces">
          <p className="text-tertiary">
            When you have more than one mailbox, <b>All inboxes</b> merges them into
            one newest-first list (each row tagged with its account); search, folder
            tabs, and bulk actions all work across the merge. Use <b>Spaces</b> to
            scope the view to a subset of mailboxes and agents.
          </p>
        </Section>

        <Section title="Connect Email-Ops to Claude &amp; agents (MCP)">
          <p className="text-tertiary">
            Mint a personal access token (<span className="mono">eo_pat_…</span>) and
            add Email-Ops as an MCP server so Claude Code and suite agents can read,
            triage, and stage/send mail as you — under the same fences as this UI:
          </p>
          <pre className="mt-1 overflow-x-auto rounded-token bg-surface-overlay/60 p-3 font-mono text-[11px] leading-5 text-secondary">
{`claude mcp add --transport http email-ops \\
  https://email-ops.magicunicorn.dev/api/v1/mcp \\
  --header "Authorization: Bearer eo_pat_..."`}
          </pre>
          <p className="text-tertiary">
            See <b>docs/MCP.md</b> in the repo for the tool list and token minting.
          </p>
        </Section>

        <Section title="Keyboard shortcuts">
          <div className="grid gap-4 sm:grid-cols-3">
            {GROUPS.map((g) => (
              <div key={g.title}>
                <p className="text-[11px] font-medium uppercase tracking-wide text-tertiary">
                  {g.title}
                </p>
                <ul className="mt-2 space-y-1.5">
                  {g.rows.map(([keys, what]) => (
                    <li key={keys} className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-tertiary">{what}</span>
                      <span className="flex shrink-0 gap-1">
                        {keys.split(' / ').map((k) => (
                          <Key key={k}>{k}</Key>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </Dialog>
  );
}

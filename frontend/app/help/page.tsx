'use client';

/**
 * /help — the comprehensive Email-Ops manual.
 *
 * A real, static, in-app reference (no CMS): every section documents behavior
 * verified against the code that ships it — the autonomy matrix mirrors
 * backend/src/email/autonomy.ts, loop protection mirrors the agent-reply
 * runtime, rule caps mirror the rules service, and the keyboard table mirrors
 * useMailShortcuts. Sticky section nav with a scrollspy, plus a client-side
 * filter box that hides non-matching sections by their rendered text.
 *
 * Deep-linkable: every section and key subsection carries a stable id
 * (#autonomy-trust, #trusted-senders, #rules, #auto-sent, …) that empty states
 * and "Learn more" links across the app point at.
 */

import Link from 'next/link';
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Badge, cn } from '@/components/ui';
import { SearchIcon } from '@/components/mail/icons';

/* ------------------------------------------------------------------ chrome -- */

const NAV: { id: string; title: string }[] = [
  { id: 'getting-started', title: 'Getting started' },
  { id: 'reading-organizing', title: 'Reading & organizing' },
  { id: 'search', title: 'Search' },
  { id: 'agents', title: 'Agents & their mailboxes' },
  { id: 'approvals', title: 'The approval queue' },
  { id: 'autonomy-trust', title: 'Autonomy & trust' },
  { id: 'cleanup', title: 'Cleanup & connected accounts' },
  { id: 'sms', title: 'SMS' },
  { id: 'integrations', title: 'Automation & integrations' },
  { id: 'troubleshooting', title: 'Troubleshooting' },
  { id: 'keyboard', title: 'Keyboard & power use' },
];

function K({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex min-w-[20px] items-center justify-center rounded-[5px] border border-border bg-surface-overlay px-1.5 py-px text-[11px] leading-[1.5] text-secondary mono">
      {children}
    </kbd>
  );
}

function H3({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h3 id={id} className="mt-6 scroll-mt-24 text-[15px] font-semibold text-primary">
      {children}
    </h3>
  );
}

function P({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-sm leading-6 text-secondary">{children}</p>;
}

function Li({ children }: { children: ReactNode }) {
  return <li className="text-sm leading-6 text-secondary">{children}</li>;
}

function Ul({ children }: { children: ReactNode }) {
  return <ul className="mt-2 list-disc space-y-1 pl-5 marker:text-tertiary">{children}</ul>;
}

function B({ children }: { children: ReactNode }) {
  return <b className="font-semibold text-primary">{children}</b>;
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="mono text-[0.92em] text-secondary">{children}</span>;
}

function Callout({ tone = 'info', children }: { tone?: 'info' | 'warn'; children: ReactNode }) {
  return (
    <div
      className={cn(
        'mt-3 rounded-token border px-3.5 py-2.5 text-sm leading-6',
        tone === 'warn'
          ? 'border-warning/30 bg-warning-subtle text-secondary'
          : 'border-info/30 bg-info-subtle text-secondary',
      )}
    >
      {children}
    </div>
  );
}

function Section({
  id,
  title,
  lead,
  children,
}: {
  id: string;
  title: string;
  lead?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      data-help-section
      className="scroll-mt-6 rounded-token-lg border border-subtle bg-surface-raised p-5 shadow-token sm:p-6"
    >
      <h2 className="text-xl font-semibold tracking-[-0.01em] text-primary">{title}</h2>
      {lead ? <p className="mt-2 text-sm leading-6 text-tertiary">{lead}</p> : null}
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------- page -- */

export default function HelpPage() {
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string>(NAV[0].id);
  const [matches, setMatches] = useState<ReadonlySet<string> | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  // Client-side filter: hide sections whose rendered text doesn't contain the
  // query. DOM-driven on purpose — the content is static JSX, and textContent
  // is exactly what the reader sees.
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const q = query.trim().toLowerCase();
    if (!q) {
      setMatches(null);
      return;
    }
    const found = new Set<string>();
    for (const el of root.querySelectorAll<HTMLElement>('[data-help-section]')) {
      const text = (el.textContent ?? '').toLowerCase();
      if (text.includes(q)) found.add(el.id);
    }
    setMatches(found);
  }, [query]);

  // Scrollspy — highlight the section closest to the top of the viewport.
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const sections = [...root.querySelectorAll<HTMLElement>('[data-help-section]')];
    if (sections.length === 0) return;
    const visible = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.set(entry.target.id, entry.boundingClientRect.top);
          else visible.delete(entry.target.id);
        }
        if (visible.size > 0) {
          const top = [...visible.entries()].sort((a, b) => a[1] - b[1])[0][0];
          setActiveId(top);
        }
      },
      { rootMargin: '-10% 0px -60% 0px' },
    );
    for (const el of sections) io.observe(el);
    return () => io.disconnect();
  }, []);

  const filtering = matches !== null;
  const visibleCount = filtering ? matches.size : NAV.length;

  return (
    <div className="space-y-6">
      <header>
        <Badge variant="protected">manual</Badge>
        <h1 className="mt-3 text-3xl font-semibold tracking-[-0.02em] text-primary">
          Email-Ops Help
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-tertiary">
          How the whole app works — mail, agents, the approval queue, autonomy levels, trust,
          cleanup, and every keyboard shortcut. Everything here describes what the software
          actually does.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[230px_minmax(0,1fr)]">
        {/* Sticky section nav + filter */}
        <aside className="lg:sticky lg:top-4 lg:self-start">
          <label className="flex h-9 items-center gap-2 rounded-lg border border-subtle bg-surface-raised px-3 text-tertiary transition-colors focus-within:border-accent hover:border-border">
            <SearchIcon className="h-[14px] w-[14px] shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter this guide…"
              aria-label="Filter help sections"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-primary outline-none placeholder:text-tertiary"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear filter"
                className="rounded px-1 text-[11px] text-tertiary hover:text-primary"
              >
                ×
              </button>
            )}
          </label>
          <nav aria-label="Help sections" className="mt-3 hidden lg:block">
            <ul className="space-y-0.5">
              {NAV.map((item) => {
                const hidden = filtering && !matches.has(item.id);
                const active = !filtering && item.id === activeId;
                return (
                  <li key={item.id} className={cn(hidden && 'opacity-35')}>
                    <a
                      href={`#${item.id}`}
                      aria-current={active ? 'true' : undefined}
                      className={cn(
                        'block rounded-lg border-l-2 px-2.5 py-1.5 text-[13px] transition-colors',
                        active
                          ? 'border-accent bg-accent/[0.08] font-medium text-primary'
                          : 'border-transparent text-tertiary hover:bg-surface-overlay hover:text-secondary',
                      )}
                    >
                      {item.title}
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>
        </aside>

        {/* Sections */}
        <div ref={contentRef} className="min-w-0 space-y-5">
          {filtering && visibleCount === 0 && (
            <div className="rounded-token-lg border border-dashed border-subtle p-8 text-center text-sm text-tertiary">
              Nothing in the guide matches “{query}”. Try a shorter word.
            </div>
          )}

          <div className={cn(filtering && !matches.has('getting-started') && 'hidden')}>
            <GettingStarted />
          </div>
          <div className={cn(filtering && !matches.has('reading-organizing') && 'hidden')}>
            <ReadingOrganizing />
          </div>
          <div className={cn(filtering && !matches.has('search') && 'hidden')}>
            <SearchSection />
          </div>
          <div className={cn(filtering && !matches.has('agents') && 'hidden')}>
            <AgentsSection />
          </div>
          <div className={cn(filtering && !matches.has('approvals') && 'hidden')}>
            <ApprovalsSection />
          </div>
          <div className={cn(filtering && !matches.has('autonomy-trust') && 'hidden')}>
            <AutonomySection />
          </div>
          <div className={cn(filtering && !matches.has('cleanup') && 'hidden')}>
            <CleanupSection />
          </div>
          <div className={cn(filtering && !matches.has('sms') && 'hidden')}>
            <SmsSection />
          </div>
          <div className={cn(filtering && !matches.has('integrations') && 'hidden')}>
            <IntegrationsSection />
          </div>
          <div className={cn(filtering && !matches.has('troubleshooting') && 'hidden')}>
            <TroubleshootingSection />
          </div>
          <div className={cn(filtering && !matches.has('keyboard') && 'hidden')}>
            <KeyboardSection />
          </div>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- sections -- */

function GettingStarted() {
  return (
    <Section
      id="getting-started"
      title="Getting started"
      lead="Email-Ops is an agent email command center: a full mail client where AI agents read, triage, and draft alongside you — and nothing they send leaves without the controls described in this guide."
    >
      <H3 id="orientation">The layout</H3>
      <P>
        The far-left icon rail is the section nav — <B>Overview</B>, <B>Mail</B>,{' '}
        <B>Approvals</B>, <B>Agents</B>, <B>Mailboxes</B>, <B>Insights</B>, <B>Cleanup</B>,{' '}
        <B>Connect device</B>, <B>Accounts</B> — and it carries a live badge when approvals are
        waiting. On <B>Mail</B> you get the five-zone cockpit: section nav · accounts &amp;
        folders · conversation list · reader · the agent rail on the right. Every pane boundary
        is draggable (drag to resize, double-click to reset), and the chevrons collapse the
        folders pane and the agent rail.
      </P>
      <H3 id="workspaces">Organizations &amp; workspaces</H3>
      <P>
        Everything lives inside a workspace (your organization&rsquo;s tenant). The switcher in
        the top bar changes the active organization; mailboxes, agents, rules, and the approval
        queue are all scoped to it. If you see &ldquo;No workspace yet&rdquo;, your account
        isn&rsquo;t a member of one — ask your workspace administrator for an invite.
      </P>
      <H3 id="spaces">Spaces</H3>
      <P>
        A <B>Space</B> is a saved subset of the workspace&rsquo;s mailboxes — e.g. one space for
        support addresses, one for your personal accounts. The space switcher sits next to the
        mailbox name in the top bar; picking a space scopes the mail view (accounts list,
        unified inbox, unread totals) to just those mailboxes. &ldquo;All&rdquo; shows
        everything again. Spaces are managed from the same switcher.
      </P>
      <H3 id="mailboxes">Mailboxes</H3>
      <P>
        The <B>Mailboxes</B> page lists every address the workspace owns and lets you provision
        new ones. Two kinds matter throughout this guide:
      </P>
      <Ul>
        <Li>
          <B>Your mailboxes</B> — sovereign addresses hosted by the built-in mail engine, plus
          any Gmail / Microsoft account you connect. Humans own these.
        </Li>
        <Li>
          <B>Agent mailboxes</B> — real addresses owned by an AI agent (see{' '}
          <a className="text-accent hover:underline" href="#agents">
            Agents &amp; their mailboxes
          </a>
          ). The autonomy rules differ between the two — that&rsquo;s the heart of{' '}
          <a className="text-accent hover:underline" href="#autonomy-trust">
            Autonomy &amp; trust
          </a>
          .
        </Li>
      </Ul>
      <H3 id="link-accounts">Linking Gmail or Microsoft</H3>
      <P>
        On <B>Accounts</B>, hit <B>Connect Google</B> / <B>Connect Microsoft</B>. That runs a
        &ldquo;sign in with&hellip;&rdquo; round-trip through the suite&rsquo;s identity broker
        (Keycloak) and grants mail consent; you land back on Accounts with the token linked.
        Then <B>Add to Mail</B> registers the account as a mailbox in the unified <B>Mail</B>{' '}
        client so you can read and send it there.
      </P>
      <Callout>
        If Gmail analysis or reading stops working later, the broker token has usually expired —
        press <B>Reconnect Google</B> on the Accounts page to re-link. It refreshes access and
        deletes nothing.
      </Callout>
    </Section>
  );
}

function ReadingOrganizing() {
  return (
    <Section
      id="reading-organizing"
      title="Reading & organizing mail"
      lead="The Mail page is a full webmail client: unified or per-mailbox inboxes, folders, threads, bulk actions, rules, snooze, scheduled send, signatures, and vacation replies."
    >
      <H3 id="inboxes">Inboxes &amp; folders</H3>
      <P>
        With more than one mailbox, <B>All inboxes</B> merges them into one newest-first list —
        each row tagged with its account color. Six system folders exist per mailbox:{' '}
        <B>Inbox</B>, <B>Sent</B>, <B>Drafts</B>, <B>Archive</B>, <B>Spam</B>, <B>Trash</B>. In
        Trash and Spam an <B>Empty</B> button permanently deletes everything there — it asks
        first, and it cannot be undone.
      </P>
      <H3 id="custom-folders">Custom folders</H3>
      <P>
        On a mailbox hosted by the built-in engine (not Gmail/Microsoft) you can create your own
        folders from the folder pane&rsquo;s <B>+</B> button — rename and delete them from the
        hover actions on each row. File an open conversation with the reader&rsquo;s{' '}
        <B>Move to folder</B> button, the <K>⌘K</K> menu, or a rule.
      </P>
      <H3 id="triage">Triage</H3>
      <P>
        Hovering a conversation row reveals quick actions — <B>Archive</B>, <B>Mark
        read/unread</B>, <B>Trash</B> — and a star toggle. The reader toolbar adds{' '}
        <B>Move to inbox</B>, <B>Report spam</B>, <B>Move to folder</B>, and <B>Snooze</B>.
        Select rows with the checkboxes (or <K>x</K>) for bulk archive / trash / mark / move.
        Archiving keeps mail (searchable, out of the inbox); Trash is reversible until emptied.
      </P>
      <H3 id="rules">Rules — file it before you see it</H3>
      <P>
        <B>Rules</B> (folder pane or <K>⌘K</K>, on an engine-hosted mailbox) are server-side
        filters that run as mail arrives, in priority order. Each rule has:
      </P>
      <Ul>
        <Li>
          <B>Conditions</B> over <Mono>From</Mono> / <Mono>To</Mono> / <Mono>Subject</Mono> /{' '}
          <Mono>From domain</Mono> with <Mono>is</Mono> / <Mono>contains</Mono> /{' '}
          <Mono>starts with</Mono> / <Mono>ends with</Mono>, combined as{' '}
          <B>All conditions must match</B> (AND) or <B>Any condition matches</B> (OR).
        </Li>
        <Li>
          <B>Actions</B>, applied in order: keep in Inbox / move to a folder / archive / trash,
          plus <B>mark as read</B>, plus <B>stop</B> (don&rsquo;t run lower-priority rules —
          on by default).
        </Li>
      </Ul>
      <P>
        Server limits: up to <B>100 rules per mailbox</B>, and a rule&rsquo;s match supports up
        to <B>5 condition groups</B> of up to <B>10 conditions each</B>. The in-app builder
        edits the flat single-group shape; a rule created through the API with nested groups
        (an AND-of-ORs) shows as &ldquo;advanced matching&rdquo; and is replaced wholesale if
        you edit its conditions here. Deleting a rule never moves mail it already filed. Each
        rule shows how many times it has applied.
      </P>
      <H3 id="snooze">Snooze</H3>
      <P>
        <B>Snooze</B> (clock icon in the reader, engine-hosted mailboxes) hides a conversation
        until a time you pick; the scheduler returns it to the Inbox then. The <B>Snoozed</B>{' '}
        entry in the folder pane lists everything currently snoozed and lets you wake or
        re-time it.
      </P>
      <H3 id="scheduled-send">Scheduled send &amp; undo send</H3>
      <P>
        In the composer, <B>Send later</B> queues the message for a preset or custom time; the{' '}
        <B>Scheduled</B> view lists queued sends and can cancel them before they leave. Plain{' '}
        <B>Send</B> on an engine-hosted mailbox also passes through a short <B>undo window</B>{' '}
        (configurable 0–30&nbsp;s under Mail settings): a bar appears with <B>Undo</B> — recall
        it and the composer reopens with your text. On Gmail / Microsoft accounts and the
        unified view, send is immediate.
      </P>
      <H3 id="drafts">Drafts</H3>
      <P>
        The composer autosaves a couple of seconds after you stop typing (once a recipient
        exists) and on close — look for the &ldquo;Saved&rdquo; tick in the footer. Reopen
        drafts from the <B>Drafts</B> folder.
      </P>
      <H3 id="signatures">Signatures</H3>
      <P>
        Manage per-mailbox signatures on the <B>Accounts</B> page (name + HTML, live preview,
        one default per mailbox). The composer appends the default automatically and has a
        signature picker to swap or drop it per message.
      </P>
      <H3 id="vacation">Vacation / out of office</H3>
      <P>
        Also on <B>Accounts</B>: a per-mailbox auto-reply with subject, rich-text message, and
        an optional start/end window. It&rsquo;s mirrored to the mail engine when available.
      </P>
      <H3 id="contacts">Recipient autocomplete</H3>
      <P>
        The To/Cc/Bcc fields suggest addresses as you type, drawn from the people this mailbox
        has already corresponded with. There is no separate address-book page to maintain.
      </P>
    </Section>
  );
}

function SearchSection() {
  return (
    <Section
      id="search"
      title="Search"
      lead="One search box in the top bar covers the current mail view."
    >
      <P>
        Press <K>/</K> (or click the box) and type — results replace the conversation list for
        the selected mailbox and folder, including across <B>All inboxes</B>. It&rsquo;s a
        full-text search over your mail on engine-hosted mailboxes; clearing the box restores
        the normal list. The segmented filter (All / Unread / Starred / Agent) further narrows
        whatever is listed — <B>Agent</B> shows only conversations with a pending agent draft.
      </P>
      <P>
        For commands rather than mail — jump folders, switch accounts, trigger actions — use
        the <K>⌘K</K> command menu instead.
      </P>
    </Section>
  );
}

function AgentsSection() {
  return (
    <Section
      id="agents"
      title="Agents & their mailboxes"
      lead="Agents are AI teammates with real email addresses. They read what arrives, draft replies, and — only within the autonomy rules — send."
    >
      <H3 id="agent-mailboxes">What an agent mailbox is</H3>
      <P>
        An agent registered on the <B>Agents</B> page can be linked to its own mailbox — a real
        address on your domain. Mail sent to that address is the agent&rsquo;s inbox; replies it
        writes go out from that same identity. Your own mailboxes are never an agent&rsquo;s
        send identity: anything an agent composes from a human mailbox always needs your
        approval, whatever its autonomy level.
      </P>
      <H3 id="email-an-agent">Emailing an agent</H3>
      <P>
        Anyone (you, a teammate, an external correspondent) can just email the agent&rsquo;s
        address. The agent reads the thread and stages or sends a reply per its autonomy level
        and the trust rules. You can also talk to agents in the <B>Chat</B> tab of the mail
        page&rsquo;s right rail — grounded in the mail currently on your screen.
      </P>
      <H3 id="agent-signature">The AI signature &amp; transparency tag</H3>
      <P>
        Every agent-authored email carries a generated signature — the agent&rsquo;s avatar,
        display name, and a bordered <B>AI AGENT</B> pill — so recipients always know they are
        corresponding with an agent. Autonomous external sends additionally append a
        transparency footer. This is not optional styling; it&rsquo;s applied by the send
        pipeline.
      </P>
      <H3 id="agent-drafts">Agent drafts in your inbox</H3>
      <P>
        When an agent stages a reply on a conversation you can see, the row shows a violet{' '}
        <B>Draft · needs approval</B> chip and the reader shows the draft card inline:{' '}
        <B>Approve &amp; send</B> sends exactly that text, <B>Edit</B> opens it in the composer
        so you can adjust and send it yourself, <B>Discard</B> rejects it — it never sends.
        The same items appear in the{' '}
        <a className="text-accent hover:underline" href="#approvals">
          approval queue
        </a>
        .
      </P>
      <H3 id="agent-rail">The agent rail</H3>
      <P>
        The right rail of the Mail page has two tabs. <B>Chat</B> talks to your agents about the
        mail in view. <B>Activity</B> is the live audit timeline (staged / sent / approved /
        rejected / paused events) with three honest 7-day server-side counts — <B>Triaged</B>{' '}
        (threads agents filed), <B>Sent</B> (agent sends, autonomous plus approved), and{' '}
        <B>Awaiting</B> (drafts pending your approval right now) — plus the per-agent autonomy
        dial at the foot.
      </P>
    </Section>
  );
}

function ApprovalsSection() {
  return (
    <Section
      id="approvals"
      title="The approval queue"
      lead="Approvals (the check-square in the nav) is the human-in-the-loop surface: agents stage work, you decide. Nothing shows as done until the server confirms it."
    >
      <H3 id="pending">Pending</H3>
      <P>
        The queue itself. Each card names the drafting agent, the recipient, and a preview —
        and opening a card shows the <B>full review panel</B>: an email exactly as the
        recipient will see it (rendered HTML, signature, attachments), or for a cleanup batch
        the complete list of every message it touches and why. Then:
      </P>
      <Ul>
        <Li>
          <B>Approve &amp; send</B> (email) delivers it — this can&rsquo;t be unsent. For a
          cleanup batch, <B>Run cleanup</B> executes it.
        </Li>
        <Li>
          <B>Reject</B> means it never sends / never runs. The record is kept for audit.
        </Li>
        <Li>
          <B>Add a note</B> attaches an optional review note to the audit record either way.
        </Li>
        <Li>
          While approving a draft to someone new, a <B>trust checkbox</B> lets you allowlist
          that correspondent for future auto-replies — see{' '}
          <a className="text-accent hover:underline" href="#trusted-senders">
            Trusted senders
          </a>
          .
        </Li>
      </Ul>
      <P>
        Cards for held sends show the <B>hold reason</B> (e.g. &ldquo;first contact&rdquo;,
        &ldquo;carries attachments&rdquo;) so you know why a human is being asked.
      </P>
      <H3 id="auto-sent">Auto-sent</H3>
      <P>
        The after-the-fact audit lane. When policy let an agent send <em>without</em>{' '}
        per-message approval (an L1/L2 internal send, or an L2 routine reply to trusted
        correspondents), the sent mail lands here. Open any row to review exactly what went out
        — and revoke trust for a recipient in one click, which routes future replies to them
        back through Pending.
      </P>
      <H3 id="history">History</H3>
      <P>
        Every approval and rejection you (or teammates) made, merged newest-first, each with
        who decided, when, and the note. Decisions are attributed — the queue is an audit
        trail, not just a to-do list.
      </P>
      <P>
        The <B>Trusted senders</B> button in the header opens the allowlist manager described
        under{' '}
        <a className="text-accent hover:underline" href="#autonomy-trust">
          Autonomy &amp; trust
        </a>
        .
      </P>
    </Section>
  );
}

function AutonomySection() {
  return (
    <Section
      id="autonomy-trust"
      title="Autonomy & trust"
      lead="Three dials decide whether an agent send goes out on its own or waits for you. This section is the exact policy the send path enforces."
    >
      <H3 id="autonomy-levels">The autonomy levels</H3>
      <Ul>
        <Li>
          <B>L0 · Draft only</B> — the agent composes and stages; every send needs a human.
        </Li>
        <Li>
          <B>L1 · Approve to send</B> — the agent sends <em>internal</em> mail (recipients on
          your own domains) on its own; anything with an external recipient stages for
          approval.
        </Li>
        <Li>
          <B>L2 · Autonomous, with audit</B> — internal mail sends on its own; external mail
          sends on its own <em>only when routine</em> (defined below). Every autonomous send is
          logged and lands in the Auto-sent lane.
        </Li>
      </Ul>
      <P>
        Set the level per agent from the autonomy dial in the mail page&rsquo;s agent rail or on
        the Agents page.
      </P>
      <H3 id="autonomy-matrix">The matrix</H3>
      <div className="mt-3 overflow-x-auto rounded-token border border-subtle">
        <table className="w-full min-w-[560px] border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-subtle bg-surface-overlay/60 text-[12px] uppercase tracking-[0.06em] text-tertiary">
              <th className="px-3 py-2.5 font-semibold">Sending mailbox · recipients</th>
              <th className="px-3 py-2.5 font-semibold">L0</th>
              <th className="px-3 py-2.5 font-semibold">L1</th>
              <th className="px-3 py-2.5 font-semibold">L2</th>
            </tr>
          </thead>
          <tbody className="text-secondary">
            <tr className="border-b border-subtle">
              <td className="px-3 py-2.5">
                <B>Your (human/shared) mailbox</B> — any recipients
              </td>
              <td className="px-3 py-2.5">Approval</td>
              <td className="px-3 py-2.5">Approval</td>
              <td className="px-3 py-2.5">Approval — always</td>
            </tr>
            <tr className="border-b border-subtle">
              <td className="px-3 py-2.5">
                <B>Agent&rsquo;s own mailbox</B> — all recipients internal
              </td>
              <td className="px-3 py-2.5">Approval</td>
              <td className="px-3 py-2.5 text-success">Sends</td>
              <td className="px-3 py-2.5 text-success">Sends</td>
            </tr>
            <tr>
              <td className="px-3 py-2.5">
                <B>Agent&rsquo;s own mailbox</B> — any external recipient
              </td>
              <td className="px-3 py-2.5">Approval</td>
              <td className="px-3 py-2.5">Approval</td>
              <td className="px-3 py-2.5">
                <span className="text-success">Sends</span> only if <B>routine</B>; otherwise
                approval
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <P>
        <B>&ldquo;Routine&rdquo;</B> means <em>all</em> of the following hold — miss any one
        and the draft is held, with every failed condition spelled out on the card:
      </P>
      <Ul>
        <Li>
          It&rsquo;s a <B>reply within an existing thread</B> to real inbound mail from those
          recipients — cold outreach always needs a human.
        </Li>
        <Li>
          <B>Every external recipient is trusted</B> — previously approved once by a human (the
          trust checkbox) or added by hand. First contact always needs a human.
        </Li>
        <Li>
          <B>No attachments.</B>
        </Li>
        <Li>
          <B>At most 5 external recipients.</B>
        </Li>
        <Li>Autonomous sending isn&rsquo;t globally disabled for the deployment.</Li>
      </Ul>
      <P>
        A per-agent recipient policy can require approval for <em>all</em> external mail — the
        dial only ever makes sends more gated, never less.
      </P>
      <H3 id="trusted-senders">Trusted senders</H3>
      <P>
        The allowlist behind auto-replies, managed from <B>Approvals → Trusted senders</B>.
        Addresses get on it two ways: you check <B>trust this correspondent</B> while approving
        a first-contact draft, or you add one by hand (with an optional note). Each row shows
        how trust was earned and how many approvals back it. <B>Revoke</B> any time — future
        agent replies to that address go back through your queue; nothing already sent is
        affected.
      </P>
      <P>
        You can trust a <B>whole domain</B> as well as a single address: type a bare domain
        (<span className="font-mono text-[0.95em]">acme.com</span>) into the add box instead of an
        address, and every current and future person at that company counts as trusted for routine
        auto-replies. Domain rows are tagged <B>whole domain</B> in the list. Approving a
        first-contact draft only ever trusts the exact address — trusting an entire domain is
        always a deliberate manual choice.
      </P>
      <H3 id="loop-protection">Loop protection</H3>
      <P>The auto-reply runtime refuses to spiral, by construction:</P>
      <Ul>
        <Li>An agent never replies to its own mail.</Li>
        <Li>
          It never auto-replies to another auto-reply (agent mail carries a machine header that
          marks it).
        </Li>
        <Li>
          It never auto-replies to another agent&rsquo;s mailbox — inter-agent tasking happens
          elsewhere, not over email.
        </Li>
        <Li>
          At most <B>5 auto-sends per thread per rolling 24 hours</B> — the next reply on that
          thread stages for approval instead.
        </Li>
      </Ul>
      <H3 id="kill-switches">Kill switches</H3>
      <Ul>
        <Li>
          <B>Pause all agents</B> — the pill in the top bar. A workspace-wide stop: agent
          composes and sends (email and SMS) are blocked until resumed. Drafts you already
          approved still send.
        </Li>
        <Li>
          <B>Per-agent pause</B> — on the Agents page, pause one agent without stopping the
          fleet.
        </Li>
        <Li>
          <B>The dial itself</B> — drop an agent to L0 and it can only draft.
        </Li>
      </Ul>
    </Section>
  );
}

function CleanupSection() {
  return (
    <Section
      id="cleanup"
      title="Cleanup & connected accounts"
      lead="Cleanup declutters a connected Gmail / Microsoft mailbox with a strict plan → review → run flow. Nothing executes from a plan you haven't approved."
    >
      <H3 id="cleanup-flow">Plan → review → run</H3>
      <Ul>
        <Li>
          <B>Plan</B> — the Cleanup page builds a read-only plan from your criteria and splits
          it into <B>Protected</B> (locked out of any action) and <B>Safe to delete</B>{' '}
          candidates, with a live banner of what the selection would free.
        </Li>
        <Li>
          <B>Review</B> — you tick exactly which safe rows are in scope. The backend re-checks
          protection rules at execution time regardless.
        </Li>
        <Li>
          <B>Run</B> — <B>Trash</B> moves them to the provider&rsquo;s trash (reversible
          there). <B>Archive &amp; purge</B> is the permanent lane: it first exports and
          verifies a restorable archive, then purges to free quota — and it&rsquo;s gated
          behind typing <Mono>ARCHIVE</Mono> to confirm. Download the archive when offered;
          free-tier cloud restore expires after about 7 days unless the workspace retains it in
          the Vault.
        </Li>
      </Ul>
      <H3 id="undo-restore">Undo &amp; the audit trail</H3>
      <P>
        Every executed batch is listed under <B>Agent Activity &amp; Audit</B> with a{' '}
        <B>Restore</B> action while its archive (or trash) is live. The same activity, with
        Undo, appears in the right rail on other pages.
      </P>
      <H3 id="cleanup-agents">When an agent proposes cleanup</H3>
      <P>
        Agents (via MCP tools) can&rsquo;t execute cleanup directly: planning is read-only, and
        any trash / delete / organize / unsubscribe they propose stages a batch into the{' '}
        <a className="text-accent hover:underline" href="#approvals">
          approval queue
        </a>{' '}
        — the review panel shows every affected message before you run it. Permanent deletion
        is always gated behind a human, whichever door it comes through.
      </P>
      <H3 id="connected-accounts">Connected accounts, insights &amp; privacy</H3>
      <P>
        The Overview and Insights pages read the connected account through the broker token —{' '}
        <B>headers and metadata only, never message content</B> — for storage gauges, category
        patterns, top senders, and age/size histograms. Disconnecting an account only removes
        access; it deletes no mail.
      </P>
    </Section>
  );
}

function SmsSection() {
  return (
    <Section
      id="sms"
      title="SMS"
      lead="SMS is a governed channel with the same controls as email — there's no separate SMS inbox page; its human surface is the approval queue."
    >
      <P>
        Where a deployment has SMS configured (Twilio), agents can compose text messages under{' '}
        <em>exactly</em> the email rules: the workspace kill switch blocks it, per-agent pause
        is honored, and the autonomy dial decides — L0/L1 SMS drafts stage into the{' '}
        <a className="text-accent hover:underline" href="#approvals">
          approval queue
        </a>{' '}
        like any email draft, while L2 sends are audited. Inbound texts are recorded to the
        workspace. If SMS isn&rsquo;t configured, nothing breaks — sends simply record as
        failed instead of silently vanishing.
      </P>
    </Section>
  );
}

function IntegrationsSection() {
  return (
    <Section
      id="integrations"
      title="Automation & integrations"
      lead="Everything the UI can do, an agent can do through the API — as you, under the same fences."
    >
      <H3 id="mcp">MCP — connect Claude &amp; suite agents</H3>
      <P>
        Email-Ops exposes an MCP server at <Mono>/api/v1/mcp</Mono>. Tools cover reading
        threads, triage, search, agent-inbox review, cleanup staging, and compose — every call
        runs as the calling user, inside their workspace, under the same entitlements and
        row-level security as this UI. Add it to Claude Code with:
      </P>
      <pre className="mt-2 overflow-x-auto rounded-token bg-surface-overlay/60 p-3 font-mono text-[11px] leading-5 text-secondary">
        {`claude mcp add --transport http email-ops \\
  https://email-ops.magicunicorn.dev/api/v1/mcp \\
  --header "Authorization: Bearer eo_pat_..."`}
      </pre>
      <H3 id="pats">Personal access tokens (PATs)</H3>
      <P>
        A PAT (<Mono>eo_pat_…</Mono>) is a long-lived token you mint for an agent or CLI.
        Today they are minted via the API (<Mono>POST /api/v1/auth/pats</Mono> with your normal
        login token — see <Mono>docs/MCP.md</Mono> in the repo); the plaintext token is shown
        exactly once. Two safety properties worth knowing:
      </P>
      <Ul>
        <Li>
          A PAT can never mint, list, or revoke other PATs — no self-perpetuating credential
          chains. Manage them with your real login.
        </Li>
        <Li>
          PATs support scopes (e.g. <Mono>mail:read</Mono>, <Mono>mail:write</Mono>,{' '}
          <Mono>agent-inbox:approve</Mono>, <Mono>cleaner:run</Mono>) so an automation can be
          limited to what it needs.
        </Li>
      </Ul>
      <H3 id="connect-device">Connect a device (IMAP / native mail apps)</H3>
      <P>
        The <B>Connect device</B> page sets up an engine-hosted mailbox in Apple Mail, Outlook,
        Thunderbird, or any IMAP client: download the Apple configuration profile, or copy the
        exact IMAP/SMTP hosts, ports, and security settings. <B>Generate mail password</B>{' '}
        mints the app password those clients use — it&rsquo;s shown once and replaces the
        previous one, so existing devices must be updated.
      </P>
      <H3 id="agent-driven-ui">Agent-driven UI</H3>
      <P>
        Agents with UI-control access can drive this app for you — open a thread, prefill the
        composer, switch spaces, or pop a notification. Anything prefilled still goes through
        you: an agent-opened composer is just a composer; you review and press Send.
      </P>
    </Section>
  );
}

function TroubleshootingSection() {
  return (
    <Section
      id="troubleshooting"
      title="Troubleshooting"
      lead="The app prefers honest degraded states over fake success. Here's what the common ones mean."
    >
      <Ul>
        <Li>
          <B>Gmail / Microsoft stopped loading or analyzing</B> — the broker token expired.
          Accounts → <B>Reconnect Google</B> (or Microsoft). Re-linking refreshes access and
          touches no mail.
        </Li>
        <Li>
          <B>&ldquo;Recorded — will send once the engine is live&rdquo;</B> after Send — the
          mail engine is dormant on this deployment. Your message is safely recorded and goes
          out when the engine connects; the composer stays open so you can see the truthful
          status.
        </Li>
        <Li>
          <B>&ldquo;…not available on this server yet&rdquo;</B> (auto-sent lane, trusted
          correspondents, folders, snooze) — that backend wave isn&rsquo;t deployed here. The
          UI hides or degrades the feature honestly; until the auto-sent lane exists, nothing
          sends without landing in your Pending queue first.
        </Li>
        <Li>
          <B>&ldquo;Activity unavailable&rdquo;</B> in the agent rail — the activity feed
          endpoint isn&rsquo;t reachable; the approval counts still reflect the live queue.
        </Li>
        <Li>
          <B>A held draft you expected to auto-send</B> — read the hold reasons on the card
          (first contact, attachments, over 5 external recipients, thread rate cap, cold
          outbound, or a Class-A mailbox). That&rsquo;s the{' '}
          <a className="text-accent hover:underline" href="#autonomy-matrix">
            matrix
          </a>{' '}
          doing its job.
        </Li>
        <Li>
          <B>No workspace / no mailboxes</B> — your account isn&rsquo;t a member of a
          workspace, or none is provisioned yet. Ask your workspace administrator.
        </Li>
        <Li>
          <B>Anything else</B> — contact your workspace administrator with the exact banner
          text; every error surface in the app shows the real server message.
        </Li>
      </Ul>
    </Section>
  );
}

function KeyboardSection() {
  const groups: { title: string; rows: [ReactNode, string][] }[] = [
    {
      title: 'Navigate',
      rows: [
        [<span key="jk"><K>j</K> <K>k</K></span>, 'Next / previous conversation'],
        [<span key="open"><K>↵</K> or <K>o</K></span>, 'Open conversation'],
        [<K key="u">u</K>, 'Back to the list'],
        [<K key="slash">/</K>, 'Focus search'],
        [<K key="cmdk">⌘K</K>, 'Command menu (also Ctrl+K)'],
      ],
    },
    {
      title: 'Triage',
      rows: [
        [<K key="e">e</K>, 'Archive'],
        [<K key="hash">#</K>, 'Trash'],
        [<K key="x">x</K>, 'Select conversation (bulk bar)'],
        [<span key="iu"><K>⇧I</K> / <K>⇧U</K></span>, 'Mark read / unread'],
      ],
    },
    {
      title: 'Compose',
      rows: [
        [<K key="c">c</K>, 'Compose'],
        [<K key="r">r</K>, 'Reply'],
        [<K key="a">a</K>, 'Reply all'],
        [<K key="f">f</K>, 'Forward'],
        [<K key="send">⌘↵</K>, 'Send (in the composer)'],
      ],
    },
    {
      title: 'General',
      rows: [
        [<K key="help">?</K>, 'Quick help & shortcuts overlay'],
        [<K key="esc">Esc</K>, 'Close dialogs and menus'],
      ],
    },
  ];
  return (
    <Section
      id="keyboard"
      title="Keyboard & power use"
      lead="Gmail-style keys on the Mail page (ignored while you're typing in a field), plus the command menu."
    >
      <div className="mt-2 grid gap-5 sm:grid-cols-2">
        {groups.map((g) => (
          <div key={g.title}>
            <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-tertiary">
              {g.title}
            </p>
            <ul className="mt-2 space-y-1.5">
              {g.rows.map(([keys, what], i) => (
                <li key={i} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-secondary">{what}</span>
                  <span className="flex shrink-0 items-center gap-1">{keys}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <H3 id="panes">Panes</H3>
      <P>
        Drag any pane boundary to resize it; <B>double-click resets</B> the default width.
        Handles are keyboard operable too: <K>Tab</K> to a handle, then <K>←</K>/<K>→</K> nudge,{' '}
        <K>Home</K>/<K>End</K> jump to min/max, <K>↵</K> resets. Widths persist per browser.
      </P>
      <H3 id="command-menu">The command menu</H3>
      <P>
        <K>⌘K</K> opens a fuzzy-searchable menu of everything contextual: folders, accounts,
        filters, compose/reply/triage on the open thread, moving to custom folders, Snoozed /
        Scheduled / Rules views, mail settings, desktop notifications, and this guide.
      </P>
    </Section>
  );
}

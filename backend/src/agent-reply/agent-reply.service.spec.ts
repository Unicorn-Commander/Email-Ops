import {
  AgentReplyService,
  AGENT_REPLY_SOURCE,
  isAutomatedSender,
  THREAD_AUTO_SEND_CAP,
} from './agent-reply.service';

/**
 * Pure-unit coverage (no DB, no engines): flag gating, both pause switches, the
 * happy compose path (LLM digest → composeEmail requesting 'send' for a
 * REGISTERED agent — Wave 7: the GATE decides send-vs-draft — with the
 * idempotent external_ref + agent attribution + the loop-protection stamp/
 * attestation), LLM failure modes + the ONE spaced retry, automated-sender
 * (noreply) suppression, the Wave-7 loop guards (auto-reply header, agent-
 * sender, thread rate cap), the localpart attribution second chance, the
 * empty-thread-detail choice (STILL composes), and the never-throws backstop.
 */
describe('AgentReplyService', () => {
  const MAILBOX = { id: 'mb-agent', emailAddress: 'concierge@x.test', workspaceId: 'ws1' };
  const MSG = {
    threadId: 'T1',
    fromAddress: 'human@q.test',
    subject: 'Need help with my order',
    receivedAt: '2026-07-18T00:00:00Z',
  };
  const AGENT_ROW = {
    key: 'concierge',
    displayName: 'Concierge',
    description: null as string | null,
    autonomyLevel: 'L1_APPROVE_TO_SEND',
    paused: false,
  };
  const DETAIL = [
    {
      id: 'm1',
      threadId: 'T1',
      from: { address: 'human@q.test', name: 'Pat Human' },
      to: [],
      subject: 'Need help with my order',
      sentAt: '2026-07-17T23:59:00Z',
      preview: 'preview text',
      direction: 'received',
      cc: [],
      bcc: [],
      htmlBody: null,
      textBody: 'Hi, my order #42 never arrived. Can you check?',
      messageIdHeader: null,
      references: null,
      isUnread: true,
      flagged: false,
      attachments: [],
    },
  ];

  function make(opts?: {
    agentsPaused?: boolean;
    agent?: typeof AGENT_ROW | null;
    binding?: { agentId: string } | null;
    detail?: unknown[];
    chat?: jest.Mock;
    compose?: jest.Mock;
    /** Full control of tx.agent.findFirst (attribution second-chance tests). */
    agentFindFirst?: jest.Mock;
    /** Loop guard (c): the sender resolves to this workspace mailbox row. */
    senderMailboxRow?: { id: string; ownerKind: string } | null;
    /** Loop guard (d): runtime auto-sends already counted in this thread. */
    threadAutoSends?: number;
    /** A stored default signature row for the agent mailbox. */
    signature?: { html: string } | null;
  }) {
    const workspaceFindUnique = jest
      .fn()
      .mockResolvedValue({ agentsPaused: opts?.agentsPaused ?? false, displayName: 'Acme' });
    const bindingFindFirst = jest
      .fn()
      .mockResolvedValue(opts?.binding === undefined ? { agentId: 'a1' } : opts.binding);
    const agentFindFirst =
      opts?.agentFindFirst ??
      jest.fn().mockResolvedValue(opts?.agent === undefined ? AGENT_ROW : opts.agent);
    const mailboxFindFirst = jest.fn().mockResolvedValue(opts?.senderMailboxRow ?? null);
    const emailMessageCount = jest.fn().mockResolvedValue(opts?.threadAutoSends ?? 0);
    const signatureFindFirst = jest.fn().mockResolvedValue(opts?.signature ?? null);
    const tx = {
      workspace: { findUnique: workspaceFindUnique },
      agentMailbox: { findFirst: bindingFindFirst },
      agent: { findFirst: agentFindFirst },
      mailboxAccount: { findFirst: mailboxFindFirst },
      emailMessage: { count: emailMessageCount },
      mailSignature: { findFirst: signatureFindFirst },
    };
    const withWorkspace = jest.fn((_ws: string, _uc: string | null, cb: any) => cb(tx));
    const prisma = { withWorkspace };
    const getThreadDetail = jest.fn().mockResolvedValue(opts?.detail ?? DETAIL);
    const stalwart = { getThreadDetail };
    const chat = opts?.chat ?? jest.fn().mockResolvedValue('Happy to help — checking order #42 now.');
    const engine = { chat };
    const compose =
      opts?.compose ??
      jest.fn().mockResolvedValue({ id: 'staged-1', thread_id: 'T1', status: 'pending_approval', mode: 'draft' });
    const email = { composeEmail: compose };
    const svc = new AgentReplyService(prisma as any, stalwart as any, engine as any, email as any);
    // Fake the retry pause so LLM-failure tests don't really wait ~2.5s.
    const sleep = jest.spyOn(svc as any, 'sleep').mockResolvedValue(undefined);
    return {
      svc,
      withWorkspace,
      getThreadDetail,
      chat,
      compose,
      agentFindFirst,
      bindingFindFirst,
      mailboxFindFirst,
      emailMessageCount,
      signatureFindFirst,
      sleep,
    };
  }

  beforeEach(() => {
    process.env.AGENT_REPLY_RUNTIME_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.AGENT_REPLY_RUNTIME_ENABLED;
  });

  it('is DORMANT while AGENT_REPLY_RUNTIME_ENABLED is off: no reads, no LLM, no stage', async () => {
    delete process.env.AGENT_REPLY_RUNTIME_ENABLED;
    const { svc, withWorkspace, getThreadDetail, chat, compose } = make();
    expect(await svc.draftReplyForInbound('ws1', MAILBOX, MSG)).toBeNull();
    expect(withWorkspace).not.toHaveBeenCalled();
    expect(getThreadDetail).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(compose).not.toHaveBeenCalled();
  });

  it('respects the workspace kill switch: paused → skip before any engine/LLM work', async () => {
    const { svc, getThreadDetail, chat, compose } = make({ agentsPaused: true });
    expect(await svc.draftReplyForInbound('ws1', MAILBOX, MSG)).toBeNull();
    expect(getThreadDetail).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(compose).not.toHaveBeenCalled();
  });

  it('respects the per-agent pause: this one agent paused → skip', async () => {
    const { svc, chat, compose } = make({ agent: { ...AGENT_ROW, paused: true } });
    expect(await svc.draftReplyForInbound('ws1', MAILBOX, MSG)).toBeNull();
    expect(chat).not.toHaveBeenCalled();
    expect(compose).not.toHaveBeenCalled();
  });

  it('happy path: LLM gets the thread digest; composeEmail REQUESTS SEND (Wave 7 — the gate decides) with the idempotent ref + agent attribution + loop stamp', async () => {
    const { svc, chat, compose } = make();
    expect(await svc.draftReplyForInbound('ws1', MAILBOX, MSG)).toBe('staged-1');

    // The LLM turn: instruction names the agent persona; context carries the digest.
    expect(chat).toHaveBeenCalledTimes(1);
    const [instruction, context] = chat.mock.calls[0];
    expect(instruction).toContain('You are Concierge');
    expect(instruction).toContain('Output ONLY the reply body text');
    expect(context.thread).toEqual([
      expect.objectContaining({
        from: expect.stringContaining('human@q.test'),
        subject: 'Need help with my order',
        body: expect.stringContaining('order #42'),
      }),
    ]);

    // The ONE canonical compose lane: a REGISTERED agent requests 'send' and the
    // autonomy MATRIX decides (Wave 7); reply-to the sender, threaded, idempotent
    // per inbound message, attributed to the registered agent's key, stamped as
    // an auto-reply (loop guard a) and attested as an in-thread inbound reply.
    expect(compose).toHaveBeenCalledWith(
      'ws1',
      null,
      expect.objectContaining({
        contactId: null,
        toAddress: 'human@q.test',
        subject: 'Re: Need help with my order',
        // The body carries the LLM text + the generated signature block.
        body: expect.stringContaining('Happy to help — checking order #42 now.'),
        bodyHtml: expect.stringContaining('<p>Happy to help — checking order #42 now.</p>'),
        mode: 'send',
        inReplyToThreadId: 'T1',
        externalSource: AGENT_REPLY_SOURCE,
        externalRef: 'mb-agent:T1:2026-07-18T00:00:00Z',
        draftedBy: 'concierge',
        agentAutoreply: true,
        inboundReplyAttestation: { fromAddress: 'human@q.test' },
        transparencyFooter: expect.objectContaining({
          text: expect.stringContaining('Concierge · AI agent, sent autonomously'),
        }),
      }),
    );
    // The signature block rides in both bodies.
    const input = compose.mock.calls[0][2];
    expect(input.body).toContain('Concierge');
    expect(input.bodyHtml).toContain('Concierge');
  });

  it('LLM failure (rejects) → null, nothing staged, no throw', async () => {
    const { svc, compose } = make({ chat: jest.fn().mockRejectedValue(new Error('gateway down')) });
    expect(await svc.draftReplyForInbound('ws1', MAILBOX, MSG)).toBeNull();
    expect(compose).not.toHaveBeenCalled();
  });

  it('LLM dormant (null) or in-band ai_unavailable sentinel → null, nothing staged', async () => {
    const nulled = make({ chat: jest.fn().mockResolvedValue(null) });
    expect(await nulled.svc.draftReplyForInbound('ws1', MAILBOX, MSG)).toBeNull();
    expect(nulled.compose).not.toHaveBeenCalled();

    const sentinel = make({
      chat: jest.fn().mockResolvedValue('ai_unavailable: LITELLM_BASE_URL is not configured'),
    });
    expect(await sentinel.svc.draftReplyForInbound('ws1', MAILBOX, MSG)).toBeNull();
    expect(sentinel.compose).not.toHaveBeenCalled();
  });

  it('LLM retry: ONE spaced retry after an in-band failure — attempt 2 succeeds and stages', async () => {
    const chat = jest
      .fn()
      .mockResolvedValueOnce('ai_unavailable: single-slot server busy')
      .mockResolvedValueOnce('Second attempt draft.');
    const { svc, compose, sleep } = make({ chat });
    expect(await svc.draftReplyForInbound('ws1', MAILBOX, MSG)).toBe('staged-1');
    expect(chat).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2500);
    expect(compose).toHaveBeenCalledWith(
      'ws1',
      null,
      // Wave 7: a registered agent requests 'send' (the gate decides).
      expect.objectContaining({ body: expect.stringContaining('Second attempt draft.'), mode: 'send' }),
    );
  });

  it('LLM retry: a null first turn (engine dormant blip) is retried too', async () => {
    const chat = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('Recovered.');
    const { svc, compose } = make({ chat });
    expect(await svc.draftReplyForInbound('ws1', MAILBOX, MSG)).toBe('staged-1');
    expect(chat).toHaveBeenCalledTimes(2);
    expect(compose).toHaveBeenCalledTimes(1);
  });

  it('LLM retry: a thrown first attempt (hard-cap timeout) is retried, not fatal', async () => {
    const chat = jest
      .fn()
      .mockRejectedValueOnce(new Error('agent-reply llm timed out after 30000ms'))
      .mockResolvedValueOnce('Back on line.');
    const { svc, compose, sleep } = make({ chat });
    expect(await svc.draftReplyForInbound('ws1', MAILBOX, MSG)).toBe('staged-1');
    expect(chat).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(compose).toHaveBeenCalledTimes(1);
  });

  it('LLM retry exhausted: two failures → null, EXACTLY 2 attempts, nothing staged, no throw', async () => {
    const chat = jest.fn().mockResolvedValue('ai_unavailable: still busy');
    const { svc, compose, sleep } = make({ chat });
    await expect(svc.draftReplyForInbound('ws1', MAILBOX, MSG)).resolves.toBeNull();
    expect(chat).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(compose).not.toHaveBeenCalled();
  });

  it('EMPTY thread detail STILL drafts (documented choice): digest falls back to the inbound sender/subject', async () => {
    const { svc, chat, compose } = make({ detail: [] });
    expect(await svc.draftReplyForInbound('ws1', MAILBOX, MSG)).toBe('staged-1');
    const [, context] = chat.mock.calls[0];
    expect(context.thread).toEqual([
      expect.objectContaining({ from: 'human@q.test', subject: 'Need help with my order' }),
    ]);
    expect(compose).toHaveBeenCalledTimes(1);
  });

  it('no registered agent bound → REQUESTS DRAFT under runtime defaults (nothing unregistered can auto-send)', async () => {
    const { svc, compose } = make({ binding: null, agent: null });
    expect(await svc.draftReplyForInbound('ws1', MAILBOX, MSG)).toBe('staged-1');
    expect(compose).toHaveBeenCalledWith(
      'ws1',
      null,
      expect.objectContaining({ draftedBy: AGENT_REPLY_SOURCE, mode: 'draft' }),
    );
  });

  it('attribution second chance: mailbox lookups miss → agent resolved by key == localpart', async () => {
    // The live case: perry@magicunicorn.dev had no AgentMailbox row and no
    // mailboxAccountId cache hit, but an agent with key 'perry' existed.
    const perryBox = { id: 'mb-perry', emailAddress: 'perry@magicunicorn.dev', workspaceId: 'ws1' };
    const agentFindFirst = jest.fn(async ({ where }: any) =>
      where?.key === 'perry'
        ? { key: 'perry', displayName: 'Perry', autonomyLevel: 'L1_APPROVE_TO_SEND', paused: false }
        : null,
    );
    const { svc, compose } = make({ binding: null, agentFindFirst });
    expect(await svc.draftReplyForInbound('ws1', perryBox, MSG)).toBe('staged-1');
    // The localpart lookup stays workspace-fenced + active-only (same RLS pattern).
    expect(agentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: 'ws1', key: 'perry', active: true }),
      }),
    );
    expect(compose).toHaveBeenCalledWith(
      'ws1',
      null,
      expect.objectContaining({ draftedBy: 'perry' }),
    );
  });

  it('attribution second chance MISS: no key match either → today\'s runtime fallback exactly', async () => {
    const { svc, compose, agentFindFirst } = make({ binding: null, agent: null });
    expect(await svc.draftReplyForInbound('ws1', MAILBOX, MSG)).toBe('staged-1');
    // The localpart second chance WAS attempted (concierge@x.test → key 'concierge')…
    expect(agentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ key: 'concierge' }) }),
    );
    // …and with every lookup missing, the provenance-slug fallback is unchanged.
    expect(compose).toHaveBeenCalledWith(
      'ws1',
      null,
      expect.objectContaining({ draftedBy: AGENT_REPLY_SOURCE }),
    );
  });

  it('Wave 7: a registered L2 agent REQUESTS SEND — the compose gate (not the runtime) decides the outcome', async () => {
    const { svc, compose } = make({
      agent: { ...AGENT_ROW, autonomyLevel: 'L2_AUTONOMOUS_AUDIT' },
    });
    expect(await svc.draftReplyForInbound('ws1', MAILBOX, MSG)).toBe('staged-1');
    expect(compose).toHaveBeenCalledWith('ws1', null, expect.objectContaining({ mode: 'send' }));
  });

  // ── Wave 7 loop protection (all four) ────────────────────────────────────

  it('loop guard (b): an inbound stamped X-UC-Agent-Autoreply is NEVER answered — no gate read, no LLM, no compose', async () => {
    const { svc, withWorkspace, chat, compose } = make();
    expect(
      await svc.draftReplyForInbound('ws1', MAILBOX, { ...MSG, agentAutoreply: true }),
    ).toBeNull();
    expect(withWorkspace).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(compose).not.toHaveBeenCalled();
  });

  it('loop guard (c): a sender that is a same-workspace AGENT mailbox is never answered (ownerKind AGENT)', async () => {
    const { svc, chat, compose } = make({
      senderMailboxRow: { id: 'mb-other-agent', ownerKind: 'AGENT' },
    });
    expect(await svc.draftReplyForInbound('ws1', MAILBOX, MSG)).toBeNull();
    expect(chat).not.toHaveBeenCalled();
    expect(compose).not.toHaveBeenCalled();
  });

  it('loop guard (c): an agent-LINKED sender mailbox (Agent.mailboxAccountId cache hit) is suppressed too', async () => {
    // The sender's box is ownerKind SHARED but an active agent is linked to it:
    // tx.agent.findFirst answers the mailboxAccountId probe with a row.
    const agentFindFirst = jest.fn(async ({ where }: any) => {
      if (where?.mailboxAccountId === 'mb-linked') return { id: 'a-linked' };
      return AGENT_ROW; // every other lookup (receiving-mailbox resolution)
    });
    const { svc, compose } = make({
      senderMailboxRow: { id: 'mb-linked', ownerKind: 'SHARED' },
      agentFindFirst,
    });
    expect(await svc.draftReplyForInbound('ws1', MAILBOX, MSG)).toBeNull();
    expect(compose).not.toHaveBeenCalled();
  });

  it(`loop guard (d): ${THREAD_AUTO_SEND_CAP}+ runtime auto-sends in the thread window → REQUESTS DRAFT with reason 'thread-rate-cap'`, async () => {
    const { svc, compose } = make({ threadAutoSends: THREAD_AUTO_SEND_CAP });
    expect(await svc.draftReplyForInbound('ws1', MAILBOX, MSG)).toBe('staged-1');
    expect(compose).toHaveBeenCalledWith(
      'ws1',
      null,
      expect.objectContaining({
        mode: 'draft',
        policyReasons: [expect.objectContaining({ code: 'thread-rate-cap' })],
      }),
    );
  });

  it('loop guard (d): under the cap the runtime still requests send (no policyReasons)', async () => {
    const { svc, compose } = make({ threadAutoSends: THREAD_AUTO_SEND_CAP - 1 });
    expect(await svc.draftReplyForInbound('ws1', MAILBOX, MSG)).toBe('staged-1');
    const input = compose.mock.calls[0][2];
    expect(input.mode).toBe('send');
    expect(input.policyReasons).toBeUndefined();
  });

  // ── Wave 7 outbound quality ──────────────────────────────────────────────

  it('a stored default mailbox signature is RESPECTED (not the generated one)', async () => {
    const { svc, compose } = make({
      signature: { html: '<p>Concierge Desk — Acme Support</p>' },
    });
    await svc.draftReplyForInbound('ws1', MAILBOX, MSG);
    const input = compose.mock.calls[0][2];
    expect(input.bodyHtml).toContain('<p>Concierge Desk — Acme Support</p>');
    expect(input.body).toContain('Concierge Desk — Acme Support');
  });

  it('the generated signature carries the agent displayName + description role line', async () => {
    const { svc, compose } = make({
      agent: { ...AGENT_ROW, description: 'Customer support agent' },
    });
    await svc.draftReplyForInbound('ws1', MAILBOX, MSG);
    const input = compose.mock.calls[0][2];
    expect(input.bodyHtml).toContain('Concierge');
    expect(input.bodyHtml).toContain('Customer support agent');
    expect(input.body).toContain('Customer support agent');
  });

  it('the LLM text becomes clean paragraph HTML (escaped, <p> per blank line, <br> per newline)', async () => {
    const chat = jest
      .fn()
      .mockResolvedValue('First paragraph <script>.\n\nSecond paragraph\nwith a break.');
    const { svc, compose } = make({ chat });
    await svc.draftReplyForInbound('ws1', MAILBOX, MSG);
    const input = compose.mock.calls[0][2];
    expect(input.bodyHtml).toContain('<p>First paragraph &lt;script&gt;.</p>');
    expect(input.bodyHtml).toContain('<p>Second paragraph<br>with a break.</p>');
  });

  it('guards: no sender → skip; self-addressed (loop) → skip', async () => {
    const a = make();
    expect(await a.svc.draftReplyForInbound('ws1', MAILBOX, { ...MSG, fromAddress: null })).toBeNull();
    expect(a.compose).not.toHaveBeenCalled();

    const b = make();
    expect(
      await b.svc.draftReplyForInbound('ws1', MAILBOX, { ...MSG, fromAddress: 'Concierge@X.TEST' }),
    ).toBeNull();
    expect(b.chat).not.toHaveBeenCalled();
    expect(b.compose).not.toHaveBeenCalled();
  });

  it('suppresses automated senders BEFORE any work: no gate read, no thread read, no LLM, no stage', async () => {
    for (const from of [
      'noreply@magicunicorn.dev',
      'No-Reply@Billing.TEST',
      'DoNotReply@x.test',
      'noreply+tag@x.test',
      'bounces@list.test',
      'mailer-daemon@mta.test',
    ]) {
      const { svc, withWorkspace, getThreadDetail, chat, compose } = make();
      expect(
        await svc.draftReplyForInbound('ws1', MAILBOX, { ...MSG, fromAddress: from }),
      ).toBeNull();
      expect(withWorkspace).not.toHaveBeenCalled();
      expect(getThreadDetail).not.toHaveBeenCalled();
      expect(chat).not.toHaveBeenCalled();
      expect(compose).not.toHaveBeenCalled();
    }
  });

  it('missing subject still threads: subject becomes "Re: (no subject)"', async () => {
    const { svc, compose } = make({ detail: [] });
    expect(await svc.draftReplyForInbound('ws1', MAILBOX, { ...MSG, subject: null })).toBe('staged-1');
    expect(compose).toHaveBeenCalledWith(
      'ws1',
      null,
      expect.objectContaining({ subject: 'Re: (no subject)' }),
    );
  });

  it('an existing "Re:" subject is not stacked', async () => {
    const { svc, compose } = make();
    await svc.draftReplyForInbound('ws1', MAILBOX, { ...MSG, subject: 're: already a reply' });
    expect(compose).toHaveBeenCalledWith(
      'ws1',
      null,
      expect.objectContaining({ subject: 're: already a reply' }),
    );
  });

  it('never throws: a composeEmail refusal (e.g. pause race → Forbidden) degrades to null', async () => {
    const { svc } = make({ compose: jest.fn().mockRejectedValue(new Error('Agents are paused')) });
    await expect(svc.draftReplyForInbound('ws1', MAILBOX, MSG)).resolves.toBeNull();
  });

  it('never throws: an exploding fenced read degrades to null', async () => {
    const prisma = { withWorkspace: jest.fn().mockRejectedValue(new Error('db down')) };
    const svc = new AgentReplyService(
      prisma as any,
      { getThreadDetail: jest.fn() } as any,
      { chat: jest.fn() } as any,
      { composeEmail: jest.fn() } as any,
    );
    await expect(svc.draftReplyForInbound('ws1', MAILBOX, MSG)).resolves.toBeNull();
  });

  it('caps the thread digest to the last 5 messages, newest kept when trimming', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      ...DETAIL[0],
      id: `m${i}`,
      sentAt: `2026-07-1${i}T00:00:00Z`,
      textBody: `message number ${i}`,
    }));
    const { svc, chat } = make({ detail: many });
    await svc.draftReplyForInbound('ws1', MAILBOX, MSG);
    const [, context] = chat.mock.calls[0];
    expect(context.thread).toHaveLength(5);
    // Chronological order preserved; the LAST entry is the newest message.
    expect(context.thread[4].body).toContain('message number 7');
    expect(context.thread[0].body).toContain('message number 3');
  });
});

/**
 * The automated-sender classifier on its own: localpart-anchored,
 * case-insensitive, plus the plain noreply/no-reply prefix catch.
 */
describe('isAutomatedSender', () => {
  it.each([
    'noreply@magicunicorn.dev',
    'NoReply@MagicUnicorn.DEV',
    'no-reply@x.test',
    'NO-REPLY@x.test',
    'donotreply@x.test',
    'do-not-reply@x.test',
    'DoNotReply@x.test',
    'noreply+tag@x.test',
    'noreply.billing@x.test',
    'noreply-alerts@x.test',
    'noreply123@x.test',
    'no-reply-svc@x.test',
    'bounce@x.test',
    'bounces@x.test',
    'mailer-daemon@mta.test',
    'MAILER-DAEMON@mta.test',
    'postmaster@x.test',
  ])('flags %s as automated', (addr) => {
    expect(isAutomatedSender(addr)).toBe(true);
  });

  it.each([
    'human@q.test',
    'perry@magicunicorn.dev',
    'reply@x.test',
    'replies@x.test',
    'norepl@x.test',
    'bounced@x.test',
    'not-a-reply@x.test',
    'support@x.test',
  ])('leaves %s alone', (addr) => {
    expect(isAutomatedSender(addr)).toBe(false);
  });

  it('empty / whitespace-only input is not automated (the no-sender guard owns that skip)', () => {
    expect(isAutomatedSender('')).toBe(false);
    expect(isAutomatedSender('   ')).toBe(false);
  });
});

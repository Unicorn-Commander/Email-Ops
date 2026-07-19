import { AgentReplyService, AGENT_REPLY_SOURCE, isAutomatedSender } from './agent-reply.service';

/**
 * Pure-unit coverage (no DB, no engines): flag gating, both pause switches, the
 * happy staging path (LLM digest → composeEmail mode:'draft' with the
 * idempotent external_ref + agent attribution), LLM failure modes + the ONE
 * spaced retry, automated-sender (noreply) suppression, the localpart
 * attribution second chance, the empty-thread-detail choice (STILL drafts),
 * loop/sender guards, and the never-throws backstop.
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
    const tx = {
      workspace: { findUnique: workspaceFindUnique },
      agentMailbox: { findFirst: bindingFindFirst },
      agent: { findFirst: agentFindFirst },
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
    return { svc, withWorkspace, getThreadDetail, chat, compose, agentFindFirst, bindingFindFirst, sleep };
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

  it('happy path: LLM gets the thread digest; composeEmail stages a draft with the idempotent ref + agent attribution', async () => {
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

    // The staging lane: mode draft, reply-to the sender, threaded, idempotent
    // per inbound message, drafted by the REGISTERED agent's key.
    expect(compose).toHaveBeenCalledWith('ws1', null, {
      contactId: null,
      toAddress: 'human@q.test',
      subject: 'Re: Need help with my order',
      body: 'Happy to help — checking order #42 now.',
      mode: 'draft',
      inReplyToThreadId: 'T1',
      externalSource: AGENT_REPLY_SOURCE,
      externalRef: 'mb-agent:T1:2026-07-18T00:00:00Z',
      draftedBy: 'concierge',
    });
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
      expect.objectContaining({ body: 'Second attempt draft.', mode: 'draft' }),
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

  it('no registered agent bound → drafts under runtime defaults (draftedBy = the provenance slug)', async () => {
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

  it('L2_AUTONOMOUS_AUDIT still stages a DRAFT (v1 never-auto-send doctrine)', async () => {
    const { svc, compose } = make({
      agent: { ...AGENT_ROW, autonomyLevel: 'L2_AUTONOMOUS_AUDIT' },
    });
    expect(await svc.draftReplyForInbound('ws1', MAILBOX, MSG)).toBe('staged-1');
    expect(compose).toHaveBeenCalledWith('ws1', null, expect.objectContaining({ mode: 'draft' }));
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

import {
  AGENT_INBOX_DEEP_LINK,
  DEFAULT_NOTIFY_AGENT_ID,
  StableNotifierService,
} from './stable-notifier.service';

/**
 * Pure-unit coverage (no Nest, no network): the DORMANT rule (no webhook URL →
 * every method no-ops), the compact message format, the transport contract
 * (endpoint/bearer/body), the confirm-on-success boolean, and the never-throws
 * degrade-clean posture on any HTTP/transport failure.
 */
describe('StableNotifierService', () => {
  const FULL_ENV: Record<string, string> = {
    EMAIL_OPS_NOTIFY_WEBHOOK_URL: 'http://stable-backend:8400/api/v1/internal/agent-messages',
    EMAIL_OPS_NOTIFY_WEBHOOK_TOKEN: 'sekret',
    EMAIL_OPS_NOTIFY_ROOM: 'ops-approvals',
    EMAIL_OPS_NOTIFY_AGENT_ID: 'claude-code',
  };

  function make(env: Record<string, string | undefined>) {
    const getEnv = (k: string) => env[k];
    return new StableNotifierService(getEnv);
  }

  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    (global as any).fetch = fetchMock;
  });
  afterEach(() => {
    delete (global as any).fetch;
    jest.restoreAllMocks();
  });

  const APPROVAL = {
    id: 'item-1',
    workspaceId: 'ws1',
    kind: 'EMAIL',
    summary: 'Re: Invoice → alice@acme.test — held: L1-external-requires-approval',
    draftedBy: 'perry',
    reasons: [{ code: 'L1-external-requires-approval', message: 'First contact with this recipient needs a human.' }],
    toAddress: 'alice@acme.test',
    subject: 'Re: Invoice',
  };

  describe('DORMANT (no webhook URL)', () => {
    it('isDormant() true and NO network on either method; notifyText → false', async () => {
      const svc = make({ ...FULL_ENV, EMAIL_OPS_NOTIFY_WEBHOOK_URL: undefined });
      expect(svc.isDormant()).toBe(true);
      await svc.notifyApprovalPending(APPROVAL);
      expect(await svc.notifyText('anything')).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('an all-whitespace URL is also dormant', async () => {
      const svc = make({ ...FULL_ENV, EMAIL_OPS_NOTIFY_WEBHOOK_URL: '   ' });
      expect(svc.isDormant()).toBe(true);
      await svc.notifyApprovalPending(APPROVAL);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('formatApprovalPending', () => {
    it('EMAIL: who drafted, To/Subject, the first hold reason in plain words, deep link', () => {
      const svc = make(FULL_ENV);
      const msg = svc.formatApprovalPending(APPROVAL);
      expect(msg).toContain('Approval needed — email drafted by perry');
      expect(msg).toContain('To: alice@acme.test');
      expect(msg).toContain('Subject: Re: Invoice');
      expect(msg).toContain('Hold: First contact with this recipient needs a human.');
      expect(msg).toContain(AGENT_INBOX_DEEP_LINK);
    });

    it('CLEANUP: uses the summary, no To/Subject, no Hold line when no reasons', () => {
      const svc = make(FULL_ENV);
      const msg = svc.formatApprovalPending({
        id: 'c1',
        workspaceId: 'ws1',
        kind: 'CLEANUP',
        summary: 'Archive 12 threads in your inbox',
        draftedBy: 'email-ops-assistant',
      });
      expect(msg).toContain('Approval needed — cleanup drafted by email-ops-assistant');
      expect(msg).toContain('Archive 12 threads in your inbox');
      expect(msg).not.toContain('To:');
      expect(msg).not.toContain('Hold:');
      expect(msg).toContain(AGENT_INBOX_DEEP_LINK);
    });

    it('missing draftedBy falls back to "an agent"', () => {
      const svc = make(FULL_ENV);
      const msg = svc.formatApprovalPending({ id: 'x', workspaceId: 'ws1', kind: 'EMAIL', subject: 'Hi' });
      expect(msg).toContain('drafted by an agent');
    });
  });

  describe('transport (active)', () => {
    it('notifyApprovalPending POSTs to the endpoint with the bearer + the Stable body shape', async () => {
      const svc = make(FULL_ENV);
      await svc.notifyApprovalPending(APPROVAL);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(FULL_ENV.EMAIL_OPS_NOTIFY_WEBHOOK_URL);
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer sekret');
      expect(init.headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(init.body);
      expect(body.livekit_room_name).toBe('ops-approvals');
      expect(body.brigade_agent_id).toBe('claude-code');
      expect(body.content).toContain('Approval needed — email drafted by perry');
    });

    it('notifyText returns true on 2xx and posts the given content verbatim', async () => {
      const svc = make(FULL_ENV);
      const ok = await svc.notifyText('4 approvals waiting, oldest 3d');
      expect(ok).toBe(true);
      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.content).toBe('4 approvals waiting, oldest 3d');
    });

    it('default agent id is used when EMAIL_OPS_NOTIFY_AGENT_ID is unset; no Authorization header without a token', async () => {
      const svc = make({
        EMAIL_OPS_NOTIFY_WEBHOOK_URL: FULL_ENV.EMAIL_OPS_NOTIFY_WEBHOOK_URL,
        EMAIL_OPS_NOTIFY_ROOM: 'room-x',
      });
      await svc.notifyText('hi');
      const init = fetchMock.mock.calls[0][1];
      expect(init.headers.Authorization).toBeUndefined();
      expect(JSON.parse(init.body).brigade_agent_id).toBe(DEFAULT_NOTIFY_AGENT_ID);
    });

    it('a URL but NO room → skipped (no fetch), returns false', async () => {
      const svc = make({ EMAIL_OPS_NOTIFY_WEBHOOK_URL: FULL_ENV.EMAIL_OPS_NOTIFY_WEBHOOK_URL });
      expect(svc.isDormant()).toBe(false);
      expect(await svc.notifyText('x')).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('empty content is a no-op (no fetch), returns false', async () => {
      const svc = make(FULL_ENV);
      expect(await svc.notifyText('   ')).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('degrade-clean (never throws)', () => {
    it('a transport error (e.g. abort/timeout) → notifyText false, notifyApprovalPending resolves, no throw', async () => {
      fetchMock.mockRejectedValue(new Error('aborted'));
      const svc = make(FULL_ENV);
      await expect(svc.notifyText('x')).resolves.toBe(false);
      await expect(svc.notifyApprovalPending(APPROVAL)).resolves.toBeUndefined();
    });

    it('a non-2xx response → false, no throw', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 503 });
      const svc = make(FULL_ENV);
      await expect(svc.notifyText('x')).resolves.toBe(false);
    });
  });
});

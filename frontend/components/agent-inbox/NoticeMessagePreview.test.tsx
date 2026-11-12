import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AgentInboxNoticePayload } from '../../lib/api';
import type { MessageView } from '../../lib/mailApi';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://example.com',
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
});

let testing: typeof import('@testing-library/react');
let NoticeMessagePreview: typeof import('./NoticeMessagePreview').NoticeMessagePreview;
before(async () => {
  testing = await import('@testing-library/react');
  NoticeMessagePreview = (await import('./NoticeMessagePreview')).NoticeMessagePreview;
});

afterEach(() => testing.cleanup());

const notice: AgentInboxNoticePayload = {
  type: 'mail_rule_notice',
  ruleId: 'rule-fictional',
  ruleName: 'Vendor notice rule',
  mailboxId: 'mailbox-fictional',
  mailboxAddress: 'ops@example.com',
  threadId: 'thread-fictional',
  from: 'vendor@example.com',
  subject: 'Invoice question',
  receivedAt: '2026-11-12T07:00:00.000Z',
};

const message: MessageView = {
  id: 'message-fictional',
  thread_id: 'thread-fictional',
  from: { address: 'vendor@example.com', name: 'Vendor' },
  to: [{ address: 'ops@example.com', name: null }],
  subject: 'Invoice question',
  sent_at: '2026-11-12T07:00:00.000Z',
  preview: 'Please review invoice 42.',
  direction: 'received',
  text_body: 'Please review invoice 42.\nThank you.',
};

describe('NOTICE message preview', () => {
  it('renders the fetched sender, subject, received time, and body inline', () => {
    const { render, screen } = testing;
    render(<NoticeMessagePreview notice={notice} message={message} loading={false} />);
    assert.match(screen.getByText(/vendor@example\.com/).textContent ?? '', /vendor@example\.com/);
    assert.match(screen.getByText(/Invoice question/).textContent ?? '', /Invoice question/);
    assert.match(screen.getByText(/Please review invoice 42/).textContent ?? '', /Please review invoice 42/);
    assert.match(screen.getByText(/2026-11-12T07:00:00\.000Z/).textContent ?? '', /2026-11-12/);
  });
});

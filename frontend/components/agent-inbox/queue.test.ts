import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  filterAndSortQueue,
  formatBulkSchedule,
  pendingQueueIds,
  resolveAgentInboxOpenTarget,
  toggleVisibleSelection,
} from './queue';
import type { AgentInboxItemView } from '../../lib/api';

function item(overrides: Partial<AgentInboxItemView>): AgentInboxItemView {
  return {
    id: 'item',
    message_id: 'message',
    kind: 'EMAIL',
    approval_tier: 'mailbox_owner',
    approval_reason: null,
    state: 'pending',
    drafted_by: 'fictional-agent',
    summary: 'Fictional item',
    to_address: 'recipient@example.test',
    from_address: 'sender@example.test',
    subject: 'Fictional subject',
    body_preview: null,
    body_sha256: null,
    thread_id: null,
    kit_id: null,
    reviewed_by_uc_uid: null,
    reviewed_at: null,
    review_note: null,
    created_at: '2026-11-03T23:40:00.000Z',
    ...overrides,
  };
}

describe('agent inbox queue helpers', () => {
  it('selects and clears all visible pending ids without selecting history', () => {
    const visible = [item({ id: 'old', state: 'approved' }), item({ id: 'a' }), item({ id: 'b' })];
    const ids = pendingQueueIds(visible);
    const selected = toggleVisibleSelection(new Set<string>(), ids);
    assert.deepEqual([...selected].sort(), ['a', 'b']);
    assert.deepEqual([...toggleVisibleSelection(selected, ids)], []);
  });

  it('filters by kit and sorts by sender, with newest first as the tie-breaker', () => {
    const rows = [
      item({ id: 'older-b', from_address: 'b@example.test', kit_id: 'kit-b', created_at: '2026-11-03T23:30:00.000Z' }),
      item({ id: 'newer-a', from_address: 'a@example.test', kit_id: 'kit-a', created_at: '2026-11-03T23:40:00.000Z' }),
      item({ id: 'older-a', from_address: 'a@example.test', kit_id: 'kit-a', created_at: '2026-11-03T23:35:00.000Z' }),
    ];
    assert.deepEqual(
      filterAndSortQueue(rows, 'all', 'with-kit', 'sender').map((row) => row.id),
      ['newer-a', 'older-a', 'older-b'],
    );
    assert.deepEqual(filterAndSortQueue(rows, 'all', 'kit-a', 'created').map((row) => row.id), ['newer-a', 'older-a']);
  });

  it('renders the returned schedule in the operator confirmation shape', () => {
    const text = formatBulkSchedule({
      approved_count: 20,
      refused_count: 0,
      items: [],
      schedule: {
        first_send: '2026-11-03T18:40:00.000Z',
        last_send: '2026-11-03T19:02:00.000Z',
        count: 20,
        count_per_sender: { 'alpha@example.test': 10, 'beta@example.test': 10 },
      },
    });
    assert.match(text, /20 approved; sends from .* to .*, 10 per sender\./);
  });

  it('resolves camelCase notice ids and keeps snake_case items working', () => {
    const notice = item({
      id: 'notice-1',
      kind: 'NOTICE',
      from_address: 'vendor@example.com',
      thread_id: null,
      payload: {
        type: 'mail_rule_notice',
        threadId: 'thread-camel',
        mailboxId: 'mailbox-camel',
      },
    });
    assert.deepEqual(resolveAgentInboxOpenTarget(notice), {
      threadId: 'thread-camel',
      mailboxId: 'mailbox-camel',
    });

    const snake = item({
      thread_id: 'thread-snake',
      payload: { mailbox_id: 'mailbox-snake' },
    });
    assert.deepEqual(resolveAgentInboxOpenTarget(snake), {
      threadId: 'thread-snake',
      mailboxId: 'mailbox-snake',
    });
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_EXPIRES_IN_DAYS,
  DEFAULT_PAT_SCOPES,
  MAX_EXPIRES_IN_DAYS,
  PAT_SCOPES,
  buildCreatePatBody,
  isCreatePatBody,
  redactSecrets,
  PATS_PATH,
  rowExpiresAt,
  rowScopes,
} from '../../lib/patForm';

describe('API token form', () => {
  it('defaults to read scopes and a 90-day lifetime, not send', () => {
    assert.deepEqual(DEFAULT_PAT_SCOPES, ['mail:read', 'agent-inbox:read']);
    assert.equal(DEFAULT_PAT_SCOPES.includes('mail:write'), false);
    assert.equal(DEFAULT_EXPIRES_IN_DAYS, 90);
    assert.equal(MAX_EXPIRES_IN_DAYS, 365);
    assert.deepEqual(
      PAT_SCOPES.map((scope) => scope.id),
      [
        'mail:read',
        'mail:write',
        'agent-inbox:read',
        'agent-inbox:approve',
        'cleaner:run',
        'admin:provision',
        'ui:control',
      ],
    );
  });

  it('posts name, scopes, and expires_in_days', () => {
    const body = buildCreatePatBody({
      name: '  Northwind reader  ',
      scopes: ['mail:read', 'agent-inbox:read', 'mail:read'],
      expiresInDays: 90,
    });
    assert.equal(isCreatePatBody(body), true);
    if (!isCreatePatBody(body)) return;
    assert.deepEqual(body, {
      name: 'Northwind reader',
      scopes: ['mail:read', 'agent-inbox:read'],
      expires_in_days: 90,
    });
    assert.equal('expiresInDays' in body, false);
  });

  it('rejects an empty name, no scopes, and an expiry outside 1–365', () => {
    assert.deepEqual(buildCreatePatBody({ name: '  ', scopes: ['mail:read'], expiresInDays: 90 }), {
      error: 'Name the token.',
    });
    assert.deepEqual(buildCreatePatBody({ name: 'Desk', scopes: [], expiresInDays: 90 }), {
      error: 'Pick at least one scope.',
    });
    for (const days of [0, -1, 366, 1.5, Number.NaN]) {
      const result = buildCreatePatBody({ name: 'Desk', scopes: ['mail:read'], expiresInDays: days });
      assert.equal(isCreatePatBody(result), false);
    }
    assert.equal(
      isCreatePatBody(buildCreatePatBody({ name: 'Desk', scopes: ['mail:read'], expiresInDays: 1 })),
      true,
    );
    assert.equal(
      isCreatePatBody(buildCreatePatBody({ name: 'Desk', scopes: ['mail:read'], expiresInDays: 365 })),
      true,
    );
  });

  it('redacts a minted secret and leaves the placeholder alone', () => {
    const leaked = 'eo_pat_' + 'ABCD2345EFGH6789JKLMNPQRSTVWXYZ2';
    assert.equal(redactSecrets(`store ${leaked} now`), 'store eo_pat_… now');
    assert.equal(redactSecrets('Bearer eo_pat_…'), 'Bearer eo_pat_…');
  });

  it('shows scopes and expiry from the list, else from the mint just made', () => {
    const item = { id: 'pat-1', name: 'Northwind reader', created_at: '2026-10-26T15:00:00.000Z' };
    assert.equal(rowScopes(item), null);
    assert.equal(rowExpiresAt(item), null);
    const remembered = { scopes: ['mail:read'], expires_at: '2027-01-24T15:00:00.000Z' };
    assert.deepEqual(rowScopes(item, remembered), ['mail:read']);
    assert.equal(rowExpiresAt(item, remembered), remembered.expires_at);
    assert.deepEqual(
      rowScopes({ ...item, scopes: ['agent-inbox:read'] }, remembered),
      ['agent-inbox:read'],
    );
  });

  it('calls the session PAT routes', () => {
    assert.equal(PATS_PATH, '/auth/pats');
  });
});

// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://example.com/mail"}
// Vitest is a temporary install: see docs/connect-your-mailbox.md for the command.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MailUnavailableView } from './MailUnavailableView';

beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in this test'); }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(status, onRetry = vi.fn()) {
  return render(React.createElement(MailUnavailableView, { status, onRetry }));
}

describe('inbox unavailable vs empty', () => {
  it.each([
    ['engine_not_configured', 'Mail service is not available right now', 'Try again'],
    ['engine_unreachable', 'Mail service is not available right now', 'Try again'],
    ['provider_error', 'Could not load this mailbox', 'Try again'],
  ])('%s shows the service-unavailable next step', (status, title, action) => {
    const onRetry = vi.fn();
    show(status, onRetry);
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText(/has not been deleted/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: action }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.queryByText(/Nothing here/)).toBeNull();
    expect(screen.queryByText(/token=/i)).toBeNull();
  });

  it('provider_auth_failed tells the customer to reconnect on Accounts', () => {
    show('provider_auth_failed');
    expect(screen.getByText('Reconnect this mailbox')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Reconnect the account' }).getAttribute('href')).toBe('/accounts');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.queryByText(/token=/i)).toBeNull();
    expect(screen.queryByText(/Nothing here/)).toBeNull();
  });
});

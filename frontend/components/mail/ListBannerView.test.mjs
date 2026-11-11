// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://example.com/mail"}
// Vitest is a temporary install: see docs/connect-your-mailbox.md for the command.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ListBannerView } from './ListBannerView';
import { getProviderLinkUrl } from '../../lib/api';

vi.mock('../../lib/api', () => ({ getProviderLinkUrl: vi.fn(), apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../ActiveWorkspaceProvider', () => ({ useActiveWorkspace: () => ({ activeWorkspaceId: null }) }));

// The app's tsconfig preserves JSX for Next. Supply React for Vitest's classic
// JSX transform without changing the app's compiler or adding test dependencies.
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network is forbidden in this test'); }));
  vi.mocked(getProviderLinkUrl).mockReset();
  window.history.replaceState({}, '', '/mail');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(banner = 'no-mailboxes', overrides = {}) {
  return render(React.createElement(ListBannerView, {
    banner, error: null, spaceName: 'Customer team', onRetry: vi.fn(), ...overrides,
  }));
}

describe('inbox mailbox empty state', () => {
  it('offers both providers and explains how to finish connecting', () => {
    show();
    expect(screen.getByRole('button', { name: 'Connect Gmail' }).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Connect Microsoft 365' }).disabled).toBe(false);
    expect(screen.getByText(/After sign-in, choose Add to Mail on Accounts/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Already connected/ }).getAttribute('href')).toBe('/accounts');
    expect(getProviderLinkUrl).not.toHaveBeenCalled();
  });

  it.each([
    ['Connect Gmail', 'gmail'],
    ['Connect Microsoft 365', 'microsoft'],
  ])('starts %s with the existing broker endpoint and follows its URL', async (label, provider) => {
    // A same-page URL exercises browser navigation in jsdom without a network call.
    const url = `https://example.com/mail#broker-${provider}`;
    vi.mocked(getProviderLinkUrl).mockResolvedValue({ url });
    show();
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(getProviderLinkUrl).toHaveBeenCalledExactlyOnceWith(provider);
    await waitFor(() => expect(window.location.href).toBe(url));
  });

  it('prevents duplicate requests and lets the customer retry a failed link', async () => {
    let rejectLink;
    vi.mocked(getProviderLinkUrl).mockReturnValueOnce(new Promise((_, reject) => { rejectLink = reject; }));
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Gmail' }));
    expect(screen.getByRole('button', { name: 'Opening Gmail…' }).disabled).toBe(true);
    const microsoft = screen.getByRole('button', { name: 'Connect Microsoft 365' });
    expect(microsoft.disabled).toBe(true);
    fireEvent.click(microsoft);
    expect(getProviderLinkUrl).toHaveBeenCalledTimes(1);
    rejectLink(new Error('Your SSO session expired. Sign out and back in.'));
    expect((await screen.findByRole('alert')).textContent).toContain('Sign out and back in');
    expect(screen.getByRole('button', { name: 'Connect Gmail' }).disabled).toBe(false);
    vi.mocked(getProviderLinkUrl).mockResolvedValue({ url: 'https://example.com/mail#retry' });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Microsoft 365' }));
    await waitFor(() => expect(window.location.hash).toBe('#retry'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('gives an actionable fallback for a non-Error failure', async () => {
    vi.mocked(getProviderLinkUrl).mockRejectedValue(null);
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Gmail' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Try again');
  });

  it.each(['loading', 'error', 'no-workspace', 'no-space'])(
    'does not confuse %s with a workspace that has zero mailboxes', (banner) => {
      show(banner);
      expect(screen.queryByRole('button', { name: 'Connect Gmail' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Connect Microsoft 365' })).toBeNull();
      expect(getProviderLinkUrl).not.toHaveBeenCalled();
    },
  );

  it('preserves the mailbox-load error and retry action', () => {
    const onRetry = vi.fn();
    show('error', { error: 'Mailbox list unavailable', onRetry });
    expect(screen.getByText('Mailbox list unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

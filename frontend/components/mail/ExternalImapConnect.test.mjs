// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://example.com/mail"}
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiGet, apiPost } from '../../lib/api';
import { ListBannerView } from './ListBannerView';

vi.mock('../../lib/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn(), getProviderLinkUrl: vi.fn() }));
vi.mock('../ActiveWorkspaceProvider', () => ({ useActiveWorkspace: () => ({ activeWorkspaceId: 'workspace-one' }) }));

beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden'); }));
  vi.mocked(apiGet).mockReset();
  vi.mocked(apiPost).mockReset();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function show() {
  const onRetry = vi.fn();
  const rendered = render(React.createElement(ListBannerView, { banner: 'no-mailboxes', error: null, spaceName: null, onRetry }));
  return { ...rendered, onRetry };
}
async function fill() {
  fireEvent.click(await screen.findByRole('button', { name: 'Connect another provider (IMAP)' }));
  for (const [label, value] of [['Mailbox email address', 'reader@example.com'], ['IMAP hostname', 'imap.example.com'], ['Username', 'reader@example.com'], ['App password', 'fictional-app-password']]) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
}

describe('external IMAP empty-state connection', () => {
  it('flag off leaves the existing Connect screen unchanged', async () => {
    vi.mocked(apiGet).mockResolvedValue({ enabled: false });
    const { container } = show();
    const before = container.innerHTML;
    await waitFor(() => expect(apiGet).toHaveBeenCalledOnce());
    expect(container.innerHTML).toBe(before);
    expect(screen.queryByText('Connect another provider (IMAP)')).toBeNull();
    expect(screen.getByRole('button', { name: 'Connect Gmail' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect Microsoft 365' })).toBeTruthy();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('fails closed if the capability is unavailable', async () => {
    vi.mocked(apiGet).mockRejectedValue(new Error('Unavailable'));
    show();
    await waitFor(() => expect(apiGet).toHaveBeenCalledOnce());
    expect(screen.queryByText('Connect another provider (IMAP)')).toBeNull();
  });

  it.each([
    ['ok', 'Connection successful.'],
    ['auth_failed', 'Sign-in failed.'],
    ['tls_failed', 'A secure TLS connection could not be established.'],
    ['unreachable', 'The IMAP inbox could not be reached.'],
  ])('tests TLS 993 and renders the typed %s result', async (status, text) => {
    vi.mocked(apiGet).mockResolvedValue({ enabled: true });
    vi.mocked(apiPost).mockResolvedValue({ status, message: 'reader@example.com fictional-app-password' });
    show(); await fill();
    expect(screen.getByLabelText('App password').type).toBe('password');
    expect(screen.getByLabelText('Port (TLS only)').readOnly).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    const result = await screen.findByRole('status');
    expect(result.textContent).toContain(text);
    expect(result.textContent.includes('fictional-app-password')).toBe(false);
    expect(result.textContent.includes('reader@example.com')).toBe(false);
    expect(apiPost.mock.calls[0][0]).toBe('/workspaces/workspace-one/external-imap/test');
    expect(apiPost.mock.calls[0][1]).toMatchObject({ port: 993, security: 'tls', host: 'imap.example.com' });
    expect(document.body.textContent).toContain('Sending from this mailbox is not available yet.');
    expect(document.body.textContent.includes('\u2014')).toBe(false);
  });

  it('never displays arbitrary API errors and permits retry', async () => {
    vi.mocked(apiGet).mockResolvedValue({ enabled: true });
    vi.mocked(apiPost).mockRejectedValue(new Error('reader@example.com fictional-app-password'));
    show(); await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect((await screen.findByRole('status')).textContent).toContain('Could not complete');
    expect(document.body.textContent.includes('fictional-app-password')).toBe(false);
    expect(screen.getByRole('button', { name: 'Test connection' }).disabled).toBe(false);
  });

  it('connects, clears the password, and refreshes the mailbox list', async () => {
    vi.mocked(apiGet).mockResolvedValue({ enabled: true });
    vi.mocked(apiPost).mockResolvedValue({ status: 'ok', mailbox_id: 'mailbox-one' });
    const { onRetry } = show(); await fill();
    const changed = vi.fn();
    window.addEventListener('external-imap:connected', changed);
    fireEvent.click(screen.getByRole('button', { name: 'Connect mailbox' }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledOnce());
    expect(changed).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Connect another provider (IMAP)' }));
    expect(screen.getByLabelText('App password').value).toBe('');
    window.removeEventListener('external-imap:connected', changed);
  });
});

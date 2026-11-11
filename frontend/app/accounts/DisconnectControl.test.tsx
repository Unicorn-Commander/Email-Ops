import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { ApiError, type ConnectedProvider, type DisconnectProviderResponse } from '../../lib/api';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://example.com/accounts',
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  Element: dom.window.Element,
  DocumentFragment: dom.window.DocumentFragment,
  MutationObserver: dom.window.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
});
for (const key of [
  'Event',
  'CustomEvent',
  'MouseEvent',
  'PointerEvent',
  'KeyboardEvent',
  'FocusEvent',
  'NodeFilter',
] as const) {
  Object.defineProperty(globalThis, key, {
    value: dom.window[key],
    configurable: true,
    writable: true,
  });
}
if (!globalThis.getComputedStyle) {
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
}
const elementProto = dom.window.HTMLElement.prototype;
elementProto.scrollIntoView = () => undefined;
elementProto.hasPointerCapture = () => false;
elementProto.releasePointerCapture = () => undefined;
elementProto.setPointerCapture = () => undefined;

let testing: typeof import('@testing-library/react');
let DisconnectControl: typeof import('./DisconnectControl').DisconnectControl;

before(async () => {
  testing = await import('@testing-library/react');
  DisconnectControl = (await import('./DisconnectControl')).DisconnectControl;
});

afterEach(() => testing.cleanup());

function renderControl(
  provider: ConnectedProvider,
  linked: boolean,
  disconnect: (provider: ConnectedProvider) => Promise<DisconnectProviderResponse>,
) {
  const calls: ConnectedProvider[] = [];
  let refreshed = 0;
  testing.render(
    <DisconnectControl
      provider={provider}
      linked={linked}
      disconnect={async (next) => {
        calls.push(next);
        return disconnect(next);
      }}
      onDisconnected={() => {
        refreshed += 1;
      }}
    />,
  );
  return { calls, refreshed: () => refreshed };
}

describe('Accounts disconnect', () => {
  it('asks before unlinking and shows a typed result without an em dash', async () => {
    const { fireEvent, screen } = testing;
    const fetchCalls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      fetchCalls.push(String(input));
      throw new Error('Network is forbidden in this test');
    }) as typeof fetch;
    try {
      const { calls, refreshed } = renderControl('gmail', true, async () => ({
        provider: 'gmail',
        status: 'disconnected',
        broker: 'unlinked',
        mailboxes_deactivated: 1,
        refresh_token_cleared: false,
      }));

      const open = screen.getByRole('button', { name: 'Disconnect' });
      assert.equal(open.hasAttribute('disabled'), false);
      fireEvent.click(open);
      const dialog = await screen.findByRole('dialog');
      assert.match(dialog.textContent ?? '', /Revoking access at Gmail is still recommended/);
      const link = screen.getByRole('link', { name: 'Open Gmail app permissions' });
      assert.equal(link.getAttribute('href'), 'https://myaccount.google.com/connections');
      assert.equal(link.getAttribute('target'), '_blank');
      assert.equal(calls.length, 0);

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      assert.equal(screen.queryByRole('dialog'), null);
      assert.equal(calls.length, 0);

      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Disconnect Gmail' }));
      const status = await screen.findByRole('status');
      assert.match(status.textContent ?? '', /1 mailbox record was marked inactive/);
      assert.match(status.textContent ?? '', /Mail at Gmail was not deleted/);
      assert.match(status.textContent ?? '', /refresh token was kept/);
      assert.equal(status.textContent?.includes('\u2014'), false);
      assert.equal(status.textContent?.includes('\u2013'), false);
      assert.deepEqual(calls, ['gmail']);
      assert.equal(refreshed(), 1);
      assert.deepEqual(fetchCalls, []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('links Microsoft permissions and does not call disconnect before confirm', async () => {
    const { fireEvent, screen } = testing;
    const { calls } = renderControl('microsoft', true, async () => {
      throw new Error('should not disconnect');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    const link = await screen.findByRole('link', { name: 'Open Microsoft 365 app permissions' });
    assert.equal(link.getAttribute('href'), 'https://myaccount.microsoft.com/permissions');
    assert.equal(calls.length, 0);
  });

  it('keeps Disconnect unavailable until the account is linked', () => {
    const { screen } = testing;
    renderControl('gmail', false, async () => {
      throw new Error('should not disconnect');
    });
    const button = screen.getByRole('button', { name: 'Disconnect' });
    assert.equal(button.hasAttribute('disabled'), true);
    assert.equal(screen.queryByRole('dialog'), null);
  });

  it('shows the broker-down result and does not show success', async () => {
    const { fireEvent, screen } = testing;
    const { calls, refreshed } = renderControl('gmail', true, async () => {
      throw new ApiError(
        503,
        'The identity broker is unavailable. Nothing was changed. Try again.',
        'broker_unavailable',
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect Gmail' }));
    const alert = await screen.findByRole('alert');
    assert.match(alert.textContent ?? '', /Nothing was changed/);
    assert.equal(alert.textContent?.includes('\u2014'), false);
    assert.equal(screen.queryByRole('status'), null);
    assert.deepEqual(calls, ['gmail']);
    assert.equal(refreshed(), 0);
  });
});

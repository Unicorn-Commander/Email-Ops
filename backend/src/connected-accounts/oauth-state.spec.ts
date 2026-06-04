import {
  connectedAccountsPublicUrl,
  newOAuthNonce,
  signOAuthState,
  verifyOAuthState,
} from './oauth-state';

describe('oauth-state', () => {
  const prevJwt = process.env.JWT_SECRET;
  const prevState = process.env.CONNECTED_ACCOUNT_STATE_SECRET;

  beforeEach(() => {
    process.env.CONNECTED_ACCOUNT_STATE_SECRET = 'state-secret';
    process.env.JWT_SECRET = 'jwt-secret';
  });

  afterEach(() => {
    if (prevJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevJwt;
    if (prevState === undefined) delete process.env.CONNECTED_ACCOUNT_STATE_SECRET;
    else process.env.CONNECTED_ACCOUNT_STATE_SECRET = prevState;
  });

  it('signs and verifies a payload round-trip', () => {
    const payload = {
      workspaceId: 'ws-1',
      provider: 'gmail' as const,
      ucUid: 'uc-1',
      nonce: newOAuthNonce(),
      iat: Date.now(),
    };
    const token = signOAuthState(payload);
    expect(verifyOAuthState(token, 'gmail')).toEqual(payload);
  });

  it('rejects tampered state', () => {
    const token = signOAuthState({
      workspaceId: 'ws-1',
      provider: 'microsoft',
      ucUid: 'uc-1',
      nonce: newOAuthNonce(),
      iat: Date.now(),
    });
    expect(verifyOAuthState(`${token.slice(0, -1)}A`, 'microsoft')).toBeNull();
  });

  it('rejects expired state', () => {
    const token = signOAuthState({
      workspaceId: 'ws-1',
      provider: 'gmail',
      ucUid: 'uc-1',
      nonce: newOAuthNonce(),
      iat: Date.now() - 11 * 60 * 1000,
    });
    expect(verifyOAuthState(token, 'gmail')).toBeNull();
  });

  it('rejects a provider mismatch', () => {
    const token = signOAuthState({
      workspaceId: 'ws-1',
      provider: 'gmail',
      ucUid: 'uc-1',
      nonce: newOAuthNonce(),
      iat: Date.now(),
    });
    expect(verifyOAuthState(token, 'microsoft')).toBeNull();
  });

  it('defaults the public URL to localhost when unset', () => {
    delete process.env.CONNECTED_ACCOUNT_PUBLIC_URL;
    expect(connectedAccountsPublicUrl()).toBe('http://localhost:3231');
  });
});

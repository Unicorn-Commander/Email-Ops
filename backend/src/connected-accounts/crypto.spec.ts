import { decrypt, encrypt, isEncryptionConfigured } from './crypto';

const KEY = Buffer.alloc(32, 11).toString('base64');

describe('connected-accounts crypto', () => {
  const prevKey = process.env.CONNECTED_ACCOUNT_ENC_KEY;

  beforeEach(() => {
    process.env.CONNECTED_ACCOUNT_ENC_KEY = KEY;
  });

  afterEach(() => {
    if (prevKey === undefined) {
      delete process.env.CONNECTED_ACCOUNT_ENC_KEY;
    } else {
      process.env.CONNECTED_ACCOUNT_ENC_KEY = prevKey;
    }
  });

  it('round-trips an object', () => {
    const payload = { access_token: 'at', refresh_token: 'rt', nested: { scope: ['a', 'b'] } };
    const sealed = encrypt(payload);
    expect(typeof sealed).toBe('string');
    expect(decrypt<typeof payload>(sealed)).toEqual(payload);
  });

  it('rejects tampered ciphertext', () => {
    const sealed = encrypt({ token: 'secret' });
    const tampered = `${sealed.slice(0, -2)}AA`;
    expect(() => decrypt(tampered)).toThrow();
  });

  it('fails cleanly when the key is missing', () => {
    delete process.env.CONNECTED_ACCOUNT_ENC_KEY;
    expect(isEncryptionConfigured()).toBe(false);
    expect(() => encrypt({ token: 'secret' })).toThrow('CONNECTED_ACCOUNT_ENC_KEY is not configured');
    expect(() => decrypt('Zm9v')).toThrow();
  });
});

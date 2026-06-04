import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALG = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

function readKey(): Buffer {
  const raw = process.env.CONNECTED_ACCOUNT_ENC_KEY?.trim();
  if (!raw) {
    throw new Error('CONNECTED_ACCOUNT_ENC_KEY is not configured');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_LENGTH) {
    throw new Error('CONNECTED_ACCOUNT_ENC_KEY must be a base64-encoded 32-byte key');
  }
  return key;
}

export function isEncryptionConfigured(): boolean {
  try {
    readKey();
    return true;
  } catch {
    return false;
  }
}

export function encrypt<T extends Record<string, unknown>>(value: T): string {
  const key = readKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALG, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decrypt<T = Record<string, unknown>>(payload: string): T {
  const key = readKey();
  const raw = Buffer.from(payload, 'base64');
  if (raw.length <= IV_LENGTH + TAG_LENGTH) {
    throw new Error('Connected account ciphertext is malformed');
  }

  const iv = raw.subarray(0, IV_LENGTH);
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + TAG_LENGTH);

  try {
    const decipher = createDecipheriv(ALG, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return JSON.parse(plaintext) as T;
  } catch {
    throw new Error('Connected account ciphertext could not be decrypted');
  }
}

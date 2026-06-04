import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface OAuthStatePayload {
  workspaceId: string;
  provider: 'gmail' | 'microsoft';
  ucUid: string;
  nonce: string;
  iat: number;
}

const STATE_TTL_MS = 10 * 60 * 1000;

function readSecret(getEnv: (k: string) => string | undefined = (k) => process.env[k]): string {
  const raw = getEnv('CONNECTED_ACCOUNT_STATE_SECRET') ?? getEnv('JWT_SECRET');
  const secret = raw?.trim();
  if (!secret) {
    throw new Error('CONNECTED_ACCOUNT_STATE_SECRET or JWT_SECRET is required');
  }
  return secret;
}

export function connectedAccountsPublicUrl(
  getEnv: (k: string) => string | undefined = (k) => process.env[k],
): string {
  const raw = getEnv('CONNECTED_ACCOUNT_PUBLIC_URL');
  const value = raw?.trim();
  return value ? value.replace(/\/$/, '') : 'http://localhost:3231';
}

export function signOAuthState(
  payload: OAuthStatePayload,
  getEnv: (k: string) => string | undefined = (k) => process.env[k],
): string {
  const secret = readSecret(getEnv);
  const payloadJson = JSON.stringify(payload);
  const encodedPayload = Buffer.from(payloadJson, 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(payloadJson).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

export function verifyOAuthState(
  token: string,
  expectedProvider: OAuthStatePayload['provider'],
  getEnv: (k: string) => string | undefined = (k) => process.env[k],
  now: number = Date.now(),
): OAuthStatePayload | null {
  if (!token || typeof token !== 'string') return null;
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) return null;

  let payloadJson: string;
  try {
    payloadJson = Buffer.from(encodedPayload, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(payloadJson) as OAuthStatePayload;
  } catch {
    return null;
  }

  if (
    !payload ||
    typeof payload.workspaceId !== 'string' ||
    typeof payload.provider !== 'string' ||
    typeof payload.ucUid !== 'string' ||
    typeof payload.nonce !== 'string' ||
    !Number.isInteger(payload.iat)
  ) {
    return null;
  }

  if (payload.provider !== expectedProvider) {
    return null;
  }

  if (now - payload.iat > STATE_TTL_MS || now < payload.iat - STATE_TTL_MS) {
    return null;
  }

  let expectedSignature: string;
  try {
    expectedSignature = createHmac('sha256', readSecret(getEnv)).update(payloadJson).digest('base64url');
  } catch {
    return null;
  }

  const sigBuf = Buffer.from(signature, 'base64url');
  const expectedBuf = Buffer.from(expectedSignature, 'base64url');
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expectedBuf)) return null;

  return payload;
}

export function newOAuthNonce(): string {
  return randomBytes(16).toString('base64url');
}

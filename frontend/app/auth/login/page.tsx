'use client';

import { ssoLoginUrl } from '@/lib/api';

/**
 * SSO-only login: Email-Ops has no local password flow (greenfield, uchub realm).
 * The button hands off to the backend's Keycloak entry point.
 */
export default function Login() {
  return (
    <div className="eo-center">
      <h1>Email-Ops</h1>
      <p className="eo-muted">The mailbox surface + agent inbox of the Unicorn Commander suite.</p>
      <a href={ssoLoginUrl()}>
        <button
          style={{
            padding: '0.6rem 1.2rem',
            background: 'var(--eo-accent)',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            cursor: 'pointer',
            fontSize: '1rem',
          }}
        >
          Sign in with Unicorn Commander SSO
        </button>
      </a>
    </div>
  );
}

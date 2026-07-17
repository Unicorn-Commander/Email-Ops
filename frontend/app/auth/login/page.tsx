'use client';

import { ssoLoginUrl } from '@/lib/api';
import { Badge, Button, Card } from '@/components/ui';

export default function Login() {
  return (
    <div className="grid min-h-screen place-items-center bg-surface-base px-4">
      <Card padded className="w-full max-w-md overflow-hidden">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-token-lg bg-accent text-sm font-semibold text-accent-contrast">
            EO
          </div>
          <div>
            <p className="text-sm font-semibold text-primary">Email-Ops</p>
            <p className="text-xs text-tertiary">Email-Ops</p>
          </div>
        </div>
        <Badge variant="protected">privacy-first</Badge>
        <h1 className="mt-4 text-3xl font-semibold tracking-[-0.02em] text-primary">
          Sign in to your inbox.
        </h1>
        <p className="mt-3 text-sm leading-6 text-tertiary">
          Broker consent is explicit. The cockpit scans headers and metadata only until you review a
          plan.
        </p>
        <Button block className="mt-6" onClick={() => (window.location.href = ssoLoginUrl())}>
          Sign in with Unicorn Commander SSO
        </Button>
      </Card>
    </div>
  );
}

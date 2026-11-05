'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError } from '@/lib/api';
import { acceptInvite } from '@/lib/workspacesApi';
import { Button, Card, Skeleton } from '@/components/ui';

type State = 'loading' | 'needs-login' | 'done' | 'error';

export default function AcceptInvitationPage() {
  const router = useRouter();
  const [state, setState] = useState<State>('loading');
  const [message, setMessage] = useState('Opening invitation…');

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token')?.trim();
    if (!token) {
      setState('error');
      setMessage('This invitation link is incomplete. Ask the workspace admin to re-issue it.');
      return;
    }

    void acceptInvite({ token })
      .then((result) => {
        setState('done');
        setMessage(`You joined ${result.workspace.display_name}.`);
        window.setTimeout(() => router.replace('/dashboard'), 900);
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          setState('needs-login');
          setMessage('Sign in, then open this invitation link again.');
          return;
        }
        setState('error');
        setMessage(error instanceof Error ? error.message : 'Could not accept this invitation.');
      });
  }, [router]);

  return (
    <main className="grid min-h-screen place-items-center bg-surface-base px-4">
      <Card padded className="w-full max-w-md space-y-4">
        {state === 'loading' ? <Skeleton w={44} h={44} circle /> : null}
        <h1 className="text-xl font-semibold text-primary">
          {state === 'done' ? 'Invitation accepted' : 'Workspace invitation'}
        </h1>
        <p className="text-sm text-tertiary">{message}</p>
        {state === 'needs-login' ? (
          <Button block onClick={() => router.push('/auth/login')}>
            Sign in
          </Button>
        ) : null}
        {state === 'error' ? (
          <Button variant="secondary" onClick={() => router.replace('/dashboard')}>
            Go to Email-Ops
          </Button>
        ) : null}
      </Card>
    </main>
  );
}

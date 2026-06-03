'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getToken } from '@/lib/api';

/**
 * Entry: bounce to the agent inbox when a session exists, else to login. Phase 2
 * replaces this with the full mailbox / thread cockpit. The agent inbox is the
 * load-bearing Email-Ops-owned surface (the human-in-the-loop approval queue).
 */
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace(getToken() ? '/agent-inbox' : '/auth/login');
  }, [router]);

  return (
    <div className="eo-center">
      <div className="eo-spinner" />
    </div>
  );
}

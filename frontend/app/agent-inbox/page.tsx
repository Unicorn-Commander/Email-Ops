'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Skeleton } from '@/components/ui';

export default function AgentInboxRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/dashboard');
  }, [router]);

  return (
    <div className="space-y-4">
      <Skeleton h={120} />
      <Skeleton h={220} />
    </div>
  );
}

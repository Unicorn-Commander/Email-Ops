'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { isAuthenticated } from '@/lib/api';
import { Skeleton } from '@/components/ui';

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    if (isAuthenticated()) {
      router.replace('/dashboard');
    } else {
      // Public front door: the marketing landing is a self-contained static page
      // served from /public, outside the app shell. A hard navigation (not the
      // SPA router) loads it so its own document/styles fully take over.
      window.location.replace('/landing.html');
    }
  }, [router]);

  return (
    <div className="grid min-h-screen place-items-center bg-surface-base">
      <div className="w-full max-w-sm space-y-4 rounded-token-lg border border-subtle bg-surface-raised p-5">
        <Skeleton w={48} h={48} circle />
        <Skeleton w="70%" h={18} />
        <Skeleton w="92%" h={12} />
      </div>
    </div>
  );
}

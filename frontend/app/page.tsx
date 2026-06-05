'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getToken } from '@/lib/api';
import { Skeleton } from '@/components/ui';

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace(getToken() ? '/dashboard' : '/auth/login');
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

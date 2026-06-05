'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { setSession } from '@/lib/api';
import { Skeleton } from '@/components/ui';

function Callback() {
  const router = useRouter();
  const params = useSearchParams();
  useEffect(() => {
    const token = params.get('token');
    if (token) {
      setSession(token, null);
      router.replace('/dashboard');
    } else {
      router.replace('/auth/login');
    }
  }, [params, router]);
  return (
    <div className="grid min-h-screen place-items-center bg-surface-base">
      <div className="w-full max-w-sm space-y-4 rounded-token-lg border border-subtle bg-surface-raised p-5">
        <Skeleton w={44} h={44} circle />
        <Skeleton w="55%" h={16} />
        <p className="text-sm text-tertiary">Signing you in...</p>
      </div>
    </div>
  );
}

export default function SsoCallback() {
  return (
    <Suspense
      fallback={
        <div className="grid min-h-screen place-items-center bg-surface-base">
          <Skeleton w={44} h={44} circle />
        </div>
      }
    >
      <Callback />
    </Suspense>
  );
}

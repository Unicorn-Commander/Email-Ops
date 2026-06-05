'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ApiError,
  clearSession,
  getInboxStats,
  type ConnectedAccountsStatsResponse,
  type ConnectedProvider,
} from '@/lib/api';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

export function useInboxStats(provider: ConnectedProvider, linked: boolean) {
  const router = useRouter();
  const [load, setLoad] = useState<LoadState>(linked ? 'loading' : 'ready');
  const [data, setData] = useState<ConnectedAccountsStatsResponse | null>(
    linked
      ? null
      : {
          available: false,
          provider,
          reason: `no linked ${provider} account - sign in via ${provider} first`,
        },
  );
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!linked) {
      setData({
        available: false,
        provider,
        reason: `no linked ${provider} account - sign in via ${provider} first`,
      });
      setLoad('ready');
      setError(null);
      return;
    }

    setLoad('loading');
    setError(null);
    try {
      const next = await getInboxStats(provider);
      setData(next);
      setLoad('ready');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        router.replace('/auth/login');
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not load inbox stats.');
      setLoad('error');
    }
  }, [linked, provider, router]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    load,
    data,
    stats: data?.available ? data.stats : null,
    unavailableReason: data && !data.available ? data.reason : null,
    error,
    refresh,
  };
}

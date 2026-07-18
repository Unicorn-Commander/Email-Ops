'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import {
  ApiError,
  clearSession,
  type ConnectedProvider,
  isAuthenticated,
  listConnectedAccounts,
  type LinkedAccountView,
} from '@/lib/api';
import { normalizedAccounts, PROVIDERS } from '@/lib/cleaner-model';

const ACTIVE_PROVIDER_KEY = 'email_ops_active_provider';

interface ConnectedAccountsState {
  accounts: LinkedAccountView[];
  activeProvider: ConnectedProvider;
  activeAccount: LinkedAccountView;
  loading: boolean;
  error: string | null;
  setActiveProvider: (provider: ConnectedProvider) => void;
  refreshAccounts: () => Promise<void>;
}

const ConnectedAccountsContext = createContext<ConnectedAccountsState | null>(null);

function initialProvider(): ConnectedProvider {
  if (typeof window === 'undefined') return 'gmail';
  try {
    const saved = window.localStorage.getItem(ACTIVE_PROVIDER_KEY);
    if (saved === 'gmail' || saved === 'microsoft') return saved;
  } catch {
    // localStorage can be unavailable.
  }
  return 'gmail';
}

export function ConnectedAccountsProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [accounts, setAccounts] = useState<LinkedAccountView[]>(() => normalizedAccounts([]));
  const [activeProvider, setActiveProviderState] = useState<ConnectedProvider>(initialProvider);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setActiveProvider = useCallback((provider: ConnectedProvider) => {
    setActiveProviderState(provider);
    try {
      window.localStorage.setItem(ACTIVE_PROVIDER_KEY, provider);
    } catch {
      // localStorage can be unavailable.
    }
  }, []);

  const refreshAccounts = useCallback(async () => {
    if (!isAuthenticated()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await listConnectedAccounts();
      const next = normalizedAccounts(data.accounts ?? []);
      setAccounts(next);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        router.replace('/auth/login');
        return;
      }
      setError(err instanceof Error ? err.message : 'Could not load connected accounts.');
      setAccounts(normalizedAccounts([]));
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void refreshAccounts();
  }, [refreshAccounts]);

  const activeAccount = useMemo(
    () =>
      accounts.find((account) => account.provider === activeProvider) ??
      accounts[0] ?? { provider: PROVIDERS[0], linked: false },
    [accounts, activeProvider],
  );

  const value = useMemo<ConnectedAccountsState>(
    () => ({
      accounts,
      activeProvider,
      activeAccount,
      loading,
      error,
      setActiveProvider,
      refreshAccounts,
    }),
    [accounts, activeAccount, activeProvider, error, loading, refreshAccounts, setActiveProvider],
  );

  return (
    <ConnectedAccountsContext.Provider value={value}>
      {children}
    </ConnectedAccountsContext.Provider>
  );
}

export function useConnectedAccounts(): ConnectedAccountsState {
  const ctx = useContext(ConnectedAccountsContext);
  if (!ctx) {
    throw new Error('useConnectedAccounts must be used inside ConnectedAccountsProvider');
  }
  return ctx;
}

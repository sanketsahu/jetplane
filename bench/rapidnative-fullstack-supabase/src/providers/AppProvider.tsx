/**
 * App Provider
 *
 * Provides the Supabase client via context so screens and hooks reach it the same way.
 *
 * Synchronous now: the previous version awaited an async adapter factory and rendered a spinner
 * over the whole app until it resolved. `createClient` is a constructor call, so there is nothing
 * to wait for — and the app no longer flashes a loading screen before its first frame.
 */

import { createContext, useContext, type ReactNode } from 'react';
import { supabase } from '@/src/db/client';

type Client = typeof supabase;

interface AppContextValue {
  client: Client;
}

const AppContext = createContext<AppContextValue | null>(null);

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}

export function AppProvider({ children }: { children: ReactNode }) {
  return <AppContext.Provider value={{ client: supabase }}>{children}</AppContext.Provider>;
}

/**
 * Supabase client.
 *
 * One client for both data (`supabase.from(...)`) and auth (`supabase.auth.*`). The backend is
 * tinbase, which speaks the Supabase API, so nothing here is vendor-specific — the same code runs
 * against Supabase itself.
 *
 * WHY THERE IS NO ADAPTER LAYER
 * This template previously went through @vibecode-db/client, choosing between a mock adapter and a
 * Supabase adapter at runtime, with the schema duplicated in TypeScript. That indirection is gone:
 * the schema lives in supabase/migrations/*.sql and is applied to a real database, so there is one
 * way to reach data and it behaves the same in development and production.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

if (!url || !anonKey) {
  // Warn rather than throw: the app should still boot and render, so a missing key shows up as
  // failing queries you can see rather than a white screen before the first frame.
  console.warn('[db] EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY are not set — data calls will fail.');
}

export const supabase = createClient<Database>(url, anonKey, {
  auth: {
    // AsyncStorage, not localStorage: this runs on native, where there is no window.
    storage: AsyncStorage,
    persistSession: true,
    autoRefreshToken: true,
    // Nothing to parse on native, and leaving it on makes Supabase look for a URL and log noise.
    detectSessionInUrl: false,
  },
});

// Preview auto sign-in (designer environment = the RapidNative editor preview).
// The editor's in-sandbox database provisions this demo user at boot, so
// auth-gated screens render without a manual login. Exported apps and
// production builds never run as designer; an existing signed-in session is
// never touched, and against a user-provided Supabase (no demo user) this is
// just one failed sign-in logged to the console.
if (process.env.EXPO_PUBLIC_RAPIDNATIVE_MODE === 'designer') {
  void supabase.auth.getUser().then(async ({ data, error }) => {
    if (!error && data?.user) return;
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: 'demo@rapidnative.com',
      password: 'rapidnative-demo',
    });
    if (signInError) {
      console.warn('[preview-auth] demo sign-in failed:', signInError.message);
      return;
    }
    // Refresh useAuth's cached session so an already-rendered login gate flips over.
    const { queryClient } = await import('@/src/lib/queryClient');
    queryClient.invalidateQueries({ queryKey: ['auth'] });
  });
}

export default supabase;

/**
 * OFFLINE stub of the template's Supabase client — same exports, zero network.
 *
 * The jetplane test fixture only needs the router shape and the auth gate to
 * render; a fake in-memory session stands in for tinbase/Supabase so tests
 * run with no services at all. The demo user is signed in from the start
 * (mirrors the editor preview's auto-login) so `(app)/index` renders.
 */

type User = { id: string; email: string };
const DEMO: User = { id: '00000000-0000-0000-0000-000000000001', email: 'demo@rapidnative.com' };

let session: { user: User } | null = { user: DEMO };

const ok = <T,>(data: T) => Promise.resolve({ data, error: null as null });

export const supabase = {
  auth: {
    getSession: () => ok({ session }),
    getUser: () => ok({ user: session?.user ?? null }),
    signInWithPassword: ({ email }: { email: string; password: string }) => {
      session = { user: { id: DEMO.id, email } };
      return ok({ session, user: session.user });
    },
    signUp: ({ email }: { email: string; password: string }) => {
      session = { user: { id: 'user-' + Math.random().toString(36).slice(2, 8), email } };
      return ok({ session, user: session.user });
    },
    signOut: () => {
      session = null;
      return ok(null);
    },
    onAuthStateChange: (_cb: unknown) => ({ data: { subscription: { unsubscribe() {} } } }),
  },
  from: (_table: string) => {
    const chain: any = new Proxy(function () {}, {
      get: (_t, prop) => {
        if (prop === 'then') return (resolve: any) => resolve({ data: [], error: null });
        return () => chain;
      },
      apply: () => chain,
    });
    return chain;
  },
};

export default supabase;

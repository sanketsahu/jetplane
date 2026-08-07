# Mobile — Expo App

The primary workspace: an Expo app wired to the project's Supabase-style database. It starts clean — layouts, providers, and hooks are in place; screens and tables are added as the app grows.

## Tech Stack

- **Expo 54** with React Native 0.81
- **Expo Router 6** for file-based routing
- **TanStack Query 5** for server state (+ offline persistence)
- **NativeWind 4** for Tailwind CSS styling
- **Supabase** (`@supabase/supabase-js`) for data and auth — served by tinbase in the RapidNative editor and by `npx tinbase@0.11.1 start` or a real Supabase project elsewhere; the same code runs against all of them
- **TypeScript** strict mode, **lucide-react-native** for icons

## Getting Started

```bash
bun install
npx expo start        # press i (iOS), a (Android), or scan with Expo Go
```

The app needs a database to talk to — see the repo-root `README.md` for running Supabase locally (`npx tinbase@0.11.1 start` at the repo root) or pointing at a hosted Supabase project.

## Configuration

Two env vars, read at bundle time from `.env`:

```env
EXPO_PUBLIC_SUPABASE_URL=       # e.g. http://localhost:54321
EXPO_PUBLIC_SUPABASE_ANON_KEY=       # the anon key (public by design)
```

In the RapidNative editor these are wired automatically at preview boot; downloads ship a pre-filled `.env`. If they're missing the app still boots and renders — data calls fail with a console warning instead of a white screen.

## Project Structure

```
mobile/
├── app/                          # Expo Router pages
│   ├── _layout.tsx               # Root layout (providers, auth wiring)
│   └── (app)/
│       └── _layout.tsx           # Stack. Add (tabs)/_layout.tsx + (tabs)/index.tsx
│                                 # together if the app wants tabs — a (tabs) group
│                                 # with no screen in it competes with (app)/index.tsx
│                                 # to resolve "/" and neither renders.
├── components/                   # Reusable UI (ThemeToggle, …)
├── src/
│   ├── db/
│   │   ├── client.ts             # The supabase-js client (createClient + AsyncStorage session)
│   │   └── types.ts              # GENERATED from ../supabase/migrations — do not edit
│   ├── hooks/                    # useAuth, useOffline (+ useApp re-export)
│   ├── lib/queryClient.ts        # TanStack Query setup
│   └── providers/                # AppProvider (client context), ThemeProvider
├── theme.ts                      # Color tokens (light + dark)
├── global.css                    # Tailwind base styles
└── tailwind.config.js            # Tailwind + NativeWind config
```

## Architecture

### Data access

One client for data and auth, provided via context — no fetch calls, no per-screen client creation:

```tsx
import { useApp } from '@/src/hooks';

const { client } = useApp();
const { data, error } = await client.from('todos').select('*').order('created_at');
```

### Schema changes

The schema lives in `../supabase/migrations/*.sql` — plain Postgres DDL with RLS policies. `src/db/types.ts` is regenerated from the applied migrations whenever the schema changes, so queries are typed end-to-end. There is no TypeScript schema definition and no mock adapter: development and production hit the same kind of database.

Seed rows come from `../supabase/seed.sql` and load only into the designer database (fresh every editor session) — production is never seeded. Owner-scoped rows must reference the stable demo user (`00000000-0000-0000-0000-000000000001`), or RLS makes them invisible.

### Auth

```tsx
import { useAuth } from '@/src/hooks';

const { user, isAuthenticated, signIn, signUp, signOut } = useAuth();
signIn.mutate({ email, password }, { onSuccess: () => router.replace('/') });
```

`useAuth()` wraps `client.auth.*` in TanStack Query mutations; sessions persist via AsyncStorage.

### Provider tree

```
SafeAreaProvider
  └── ThemeProvider (NativeWind themes)
      └── QueryProvider (TanStack Query)
          └── AppProvider (supabase client context)
              └── App routes
```

### Theming

Colors are RGB tokens in `theme.ts`, consumed through semantic Tailwind classes (`bg-background`, `text-foreground`, `bg-primary`, …) — never hard-coded colors in screens.

# Expo App

## Tech Stack

Expo 54, React Native 0.81, Expo Router 6, TanStack Query 5, NativeWind 4, Supabase (tinbase), TypeScript strict, lucide-react-native

## Quick Reference

### File Locations

All paths relative to project root:

| Type                | Location                        | Export                        |
| ------------------- | ------------------------------- | ----------------------------- |
| Screens (protected) | `app/(app)/*.tsx`               | default                       |
| Screens (public)    | `app/(auth)/*.tsx`              | default                       |
| Components          | `components/*.tsx`              | named → `components/index.ts` |
| Hooks               | `src/hooks/*.ts`                | named → `src/hooks/index.ts`  |
| Providers           | `src/providers/*.tsx`           | named                         |
| Supabase client     | `src/db/client.ts`              | `supabase`                    |
| App context         | `src/providers/AppProvider.tsx` | `useApp` (provides `client`)  |
| Generated types     | `src/db/types.ts`               | `Database` (GENERATED)        |
| Migrations          | `../supabase/migrations/*.sql`  | SQL — repo root, not mobile/  |
| Seed data           | `../supabase/seed.sql`          | SQL                           |

### Client Architecture

A single Supabase client, reached through React context:

- `src/db/client.ts` — `supabase` created from `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_ANON_KEY`
- `src/providers/AppProvider.tsx` — `useApp()` returns `{ client }`
- **In screens/hooks:** `const { client } = useApp()` then `client.from('table').select('*')`
- **For auth:** use `useAuth()` hook (wraps `client.auth` in React Query mutations)
- **Editor preview is pre-authenticated:** the editor's in-sandbox database provisions a demo user (`demo@rapidnative.com`) at boot and the db client signs it in automatically — build auth-gated screens normally; the preview lands on the signed-in UI with a real email, `auth.uid()`/RLS work, and real sign-in/up flows still work for other accounts
- There is no mock adapter and no adapter switching. The database is real in every environment, so
  what you see in the preview is what ships.

### UI Components

Use React Native primitives with NativeWind styling:

| Category   | Components                                                   |
| ---------- | ------------------------------------------------------------ |
| Layout     | `View`, `SafeAreaView` (from react-native-safe-area-context) |
| Typography | `Text`                                                       |
| Forms      | `TextInput`, `Pressable`, `TouchableOpacity`                 |
| Lists      | `FlatList`, `ScrollView`, `SectionList`                      |
| Feedback   | `ActivityIndicator`                                          |
| Images     | `Image`, `ImageBackground`                                   |
| Icons      | Import from `lucide-react-native`                            |

### Rules

**Do:**

- Access the client via `useApp().client`
- Use `useAuth()` for sign in/up/out — it handles React Query cache invalidation
- Use React Native components with NativeWind `className` for all styling
- Use semantic color classes (`bg-background`, `text-foreground`, etc.)
- Check `{ error }` from all db operations
- Use query keys: `['resource', userId]`
- Include `id` on insert; let `created_at` default. Do not set `updated_at` by hand — a trigger maintains it
- Export from index.ts
- Use `useCallback` for FlatList handlers
- Use `.limit(50)` for lists
- **MANDATORY: database changes are SQL migrations — nothing else.** Call `db_migration_new` with the SQL.
  Never hand-write TypeScript schema or seed files: `src/db/types.ts` is generated from the applied
  migrations, and seed rows live in `supabase/seed.sql`.
  - New table → ONE migration containing `create table`, `alter table ... enable row level security`,
    and at least one `create policy`. RLS with no policy makes every query return zero rows, so the
    app looks broken with no error anywhere.
  - Owner-scoped data → `user_id uuid default auth.uid() references auth.users(id) on delete cascade`
    with policies like `using (auth.uid() = user_id)`. Add an index on every foreign key — Postgres
    does not create one, so the lookups seq-scan.
  - `updated_at` needs a before-update trigger, or it keeps its insert value forever.
  - Read the schema with `db_tables` / `db_describe` / `db_sql` before changing it; never guess what exists.

**Don't:**

- Import the client directly in screens — use `useApp().client`
- Call `client.auth.*` directly in screens — use `useAuth()` hook
- Use `StyleSheet.create()`
- Hardcode colors
- Write unitless arbitrary classNames — `h-[20]` is invalid and silently does nothing; always include the unit (`h-[20px]`) or use a scale class (`h-5`)
- Auto-redirect signed-in users off auth screens (`if (user) router.replace('/')`). The editor preview is always signed in, so the redirect makes login/signup screens impossible to open. If needed, gate it off in preview modes: `process.env.EXPO_PUBLIC_RAPIDNATIVE_MODE !== 'designer' && process.env.EXPO_PUBLIC_RAPIDNATIVE_MODE !== 'staging'`
- Use `any` types
- Expose raw errors to users

### Banned (will crash the app or break the web preview)

- **ORMs and schema-as-code** — no Prisma, no Drizzle, no `defineTable`. The schema is SQL in `supabase/migrations/`, applied to a real Postgres. If an ORM-shaped solution feels natural, write the SQL instead.
- **Native-only packages** — `react-native-webrtc`, `react-native-incall-manager`, `@react-native-firebase/*` and similar break the web preview the moment they're imported. Either use a web-supported alternative (browser `RTCPeerConnection`, `firebase` web SDK) or gate native code behind `Platform.OS` with a real web fallback.
- **Rewriting read-only files** — `src/db/client.ts`, `src/db/types.ts` (generated), `src/providers/AppProvider.tsx`, `src/providers/ThemeProvider.tsx`, `src/hooks/useAuth.ts`, the root `app/_layout.tsx`, and `package.json` ship complete from the scaffold. Add new code around them, never regenerate them. Never pass `value={...}` to `<ThemeProvider>` — it takes no props. Exception for `package.json`: ADDING a dependency is allowed (add-only, never remove or change existing entries) — the package must work on Expo Web (prefer `expo-*` modules) and be pinned to its Expo SDK 54-compatible version, never `latest`.
- **Hooks at module top level** — `const queryClient = useQueryClient();` outside a component crashes with "Invalid hook call". Hooks belong inside the component or another hook.
- **Hallucinated icon names** — only emit icons that actually exist in `lucide-react-native`. `MessageIcon` and `RecordIcon` do NOT exist (use `MessageCircleIcon` / `DiscIcon`). When unsure, pick the closest icon that is on the approved list.
- **Provider/consumer asymmetry** — every method called on a context (`useWebSocket().sendMessage(...)`) must be declared on the context type, included in the provider `value`, AND stubbed in the no-op fallback. Adding the consumer side alone is a runtime crash.
- **Template artifacts in source files** — never let chat-frame fragments like ` `<CodeProject> ``or stray` ```tsx ` markers end up inside `.ts` / `.tsx` files. The last line of every file must be valid syntax.

## Behavior

- Use TodoWrite for multi-step tasks
- Conventional commits: `type(scope): description`
- Read files before editing
- Prefer editing over creating new files
- Reference `.claude/skills/` for domain-specific patterns

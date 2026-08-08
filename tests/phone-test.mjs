// Interactive on-device jetplane test — YOU watch the phone, the script mutates files.
//
//   node tests/phone-test.mjs          (from the jetplane repo root)
//
// Reproduces the production shape on your host machine:
//   bake: the fullstack-supabase fixture WITHOUT its screens (= the docker image bake)
//   boot: screens restored, server boots from the STALE image (family match + freshen)
// then, one ENTER at a time, applies the same mutations RapidNative's agent makes —
// edit screen, new route, theme.ts, wholesale app.json rewrite, global.css — and tells
// you what to expect on the phone before each one. Ctrl-C restores everything.
//
// The fixture has no database dependency (src/db/client.ts is an offline stub with a
// pre-signed-in demo user), so nothing else needs to run.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = path.join(REPO, 'tests', 'fixtures', 'router-app')
const PORT = 8137
const HOME = path.join(os.homedir(), '.jetplane-phone-test') // persistent: re-runs skip the bake
const SCREENS = ['app/(app)/index.tsx', 'app/(auth)/login.tsx']

const cyan = (s) => `\x1b[36m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`
const say = (s) => console.log(cyan(`\n[phone-test] ${s}`))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, step = 1000) {
  const dl = Date.now() + ms
  while (Date.now() < dl) { if (await fn().catch(() => false)) return true; await sleep(step) }
  return false
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
// Resolve on ENTER; with piped/closed stdin (headless smoke runs) fall back to a
// short pause instead of crashing on readline EOF.
const enter = (msg) => new Promise((res) => {
  if (!process.stdin.isTTY) { console.log(bold(`\n>>> ${msg} — (no TTY, auto-continuing in 3s)`)); setTimeout(res, 3000); return }
  try { rl.question(bold(`\n>>> ${msg} — press ENTER `), res) } catch { setTimeout(res, 3000) }
})

// every file this script touches gets restored on exit
const saved = new Map()
const remember = (rel) => { const abs = path.join(DIR, rel); if (!saved.has(abs)) saved.set(abs, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null) }
const write = (rel, content) => { remember(rel); const abs = path.join(DIR, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, content) }
const edit = (rel, fn) => { remember(rel); const abs = path.join(DIR, rel); fs.writeFileSync(abs, fn(fs.readFileSync(abs, 'utf8'))) }
const restoreAll = () => { for (const [abs, src] of saved) { if (src == null) fs.rmSync(abs, { force: true }); else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, src) } } }

let srv = null
const kill = () => { if (srv) try { process.kill(-srv.pid) } catch {} ; srv = null }
const cleanup = () => { kill(); restoreAll(); try { rl.close() } catch {} }
process.on('SIGINT', () => { say('cleaning up (restoring files, stopping server)...'); cleanup(); process.exit(0) })
process.on('exit', cleanup)

const serveUp = () => until(async () => (await fetch(`http://localhost:${PORT}/status`)).ok, 10 * 60_000, 1500)
function startServe(inheritIO) {
  srv = spawn('node', [path.join(REPO, 'bin', 'jetplane.mjs'), 'serve', '--port', String(PORT)], {
    cwd: DIR, env: { ...process.env, JETPLANE_HOME: HOME }, detached: true,
    stdio: inheritIO ? ['ignore', 'inherit', 'inherit'] : 'ignore',
  })
}

// ── prep ──────────────────────────────────────────────────────────────────────
const link = path.join(DIR, 'node_modules', 'jetplane')
if (!fs.existsSync(link)) fs.symlinkSync(REPO, link)
if (!fs.existsSync(path.join(DIR, 'node_modules', 'expo'))) {
  console.error('fixture node_modules missing — run: cd tests/fixtures/router-app && npm install --legacy-peer-deps')
  process.exit(1)
}

// ── bake (scaffold-only, like the docker image) ───────────────────────────────
say('STEP 0 — bake the scaffold-only image (what orchd bakes into docker)')
for (const rel of SCREENS) remember(rel)
for (const rel of SCREENS) fs.rmSync(path.join(DIR, rel), { force: true })
startServe(false)
say('baking... (first run ≈ 4 min of Metro; re-runs are cached)')
if (!(await serveUp())) { console.error('bake serve never came up'); process.exit(1) }
kill()
await until(async () => !(await fetch(`http://localhost:${PORT}/status`).then(() => true).catch(() => false)), 15_000, 500)
restoreAll() // screens are back: the project now has files the image has never seen
say('bake done. Screens restored on disk — the image on disk is now STALE, like production.')

// ── boot from the stale image ─────────────────────────────────────────────────
say('STEP 1 — boot from the stale image (family match + boot freshening)')
startServe(true) // inherit stdio: you get jetplane logs + the QR right in this terminal
if (!(await serveUp())) { console.error('server did not come up'); process.exit(1) }
say(`serving. Scan the QR above with Expo Go (same Wi-Fi).
  EXPECT on the phone: the app boots to the HOME screen ("Welcome home") —
  a screen that is NOT in the baked bundle. If you see it, boot freshening works.`)

await enter('when the app is showing on your phone, continue to the HMR steps')

// ── mutations, one by one ─────────────────────────────────────────────────────
say('STEP 2 — edit the existing home screen (plain HMR)')
say('EXPECT: title hot-swaps to "HMR update ✓" within ~2s, no reload, state kept')
edit('app/(app)/index.tsx', (s) => s.replace(/Welcome home|HMR update ✓/, 'HMR update ✓'))
await enter('did the title change? next: add a brand-new route file')

say('STEP 3 — add a NEW route file + link it from home')
say('EXPECT: a "Go to About" link appears on home within ~3s; tapping it opens the About screen')
write('app/(app)/about.tsx', `import { Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function AboutScreen() {
  return (
    <SafeAreaView className="flex-1 bg-background">
      <View className="flex-1 items-center justify-center">
        <Text testID="about-title" className="text-2xl font-bold text-foreground">About — new route via HMR</Text>
      </View>
    </SafeAreaView>
  );
}
`)
await sleep(1500) // let the new-route update land before the screen that links to it
edit('app/(app)/index.tsx', (s) => s
  .replace("import { useAuth } from '../../src/hooks';", "import { Link } from 'expo-router';\nimport { useAuth } from '../../src/hooks';")
  .replace(/<Text className="px-4 pb-2 text-muted-foreground">/, `<Link href="/about" className="px-4 pb-2 text-primary">Go to About →</Link>\n      <Text className="px-4 pb-2 text-muted-foreground">`))
await enter('does the link show and the About screen open? next: theme.ts')

say('STEP 4 — update theme.ts (root-level file: the watcher fix)')
say('EXPECT: primary color turns RED within ~2s ("Sign out" text, the About link) — in light AND dark mode')
edit('theme.ts', (s) => s
  .replace('"--primary": "24 24 27"', '"--primary": "220 38 38"')      // light theme
  .replace('"--primary": "228 228 231"', '"--primary": "248 113 113"')) // dark theme (lighter red)
await enter('did the color change? next: the AI-style app.json rewrite')

say('STEP 5 — rewrite app.json wholesale (what the agent does: rename + drop fields)')
say(`EXPECT: NOTHING breaks. No freeze, no rebuild — the server log above must NOT say
  "building bundle". The new name ("Phone Test App") shows after you reload the app.`)
edit('app.json', (s) => {
  const d = JSON.parse(s); const e = d.expo ?? d
  e.name = 'Phone Test App'
  delete e.experiments; delete e.newArchEnabled; delete e.sdkVersion
  if (Array.isArray(e.plugins)) e.plugins = e.plugins.map((p) =>
    Array.isArray(p) && p[0] === 'expo-splash-screen' ? [p[0], { ...p[1], backgroundColor: '#fefce8' }] : p)
  return JSON.stringify(d, null, 2)
})
await enter('server still healthy? (check the log above) next: global.css')

say('STEP 6 — edit global.css (live registry refresh)')
say(`EXPECT: the "Welcome home"/"HMR update ✓" title gets WIDE letter-spacing within
  ~4s — tailwind re-runs and the fresh registry is hot-pushed (injectData re-applies).`)
edit('global.css', (s) => s + '\n@layer utilities { .text-xl { letter-spacing: 6px; } }\n')
await enter('done — ENTER restores every file and stops the server')

say('All steps done. Restoring files and shutting down.')
cleanup()
process.exit(0)

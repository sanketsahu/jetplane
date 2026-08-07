// S2 of the local-first pyramid: jetplane in PLAIN docker on the host.
//
//   node tests/docker.mjs
//
// No image build. node:20-slim + bun, the router fixture bind-mounted at /app
// (its node_modules shadowed by an anonymous volume — linux needs its own
// binaries), THIS checkout mounted at /jetplane and linked into the project.
// Everything asserted from the host against the published port, and HMR edits
// are written on the HOST side — that is exactly the docker file-watching
// question this rung exists to answer.
import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = path.join(REPO, 'tests', 'fixtures', 'router-app')
const PORT = 8134
const NAME = 'jp-s2-plain-docker'
const SCREEN = path.join(DIR, 'app', '(app)', 'index.tsx')

const results = []
const record = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, step = 1000) {
  const dl = Date.now() + ms
  while (Date.now() < dl) { if (await fn().catch(() => false)) return true; await sleep(step) }
  return false
}
const sh = (cmd) => execSync(cmd, { stdio: 'pipe' }).toString()

// fake /hot client (same protocol as tests/run.mjs), match by sourceURL
function hmrClient(editFn, expectRel, timeoutMs = 45000) {
  const want = expectRel.replace(/\.(t|j)sx?$/, '')
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/hot`)
    const done = (v) => { try { ws.close() } catch {} ; clearTimeout(t); resolve(v) }
    const t = setTimeout(() => done(null), timeoutMs)
    ws.onopen = () => ws.send(JSON.stringify({ type: 'register-entrypoints', entryPoints: ['/node_modules/expo-router/entry.bundle?platform=ios&dev=true'] }))
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data))
      if (msg.type === 'bundle-registered') editFn()
      if (msg.type === 'update' && msg.body?.modified?.length) {
        const urls = [...msg.body.modified, ...(msg.body.added || [])].map((e) => e.sourceURL || '')
        if (urls.some((u) => u.includes(want))) done(msg.body)
      }
    }
    ws.onerror = () => done(null)
  })
}

try { sh(`docker rm -f ${NAME}`) } catch {}

// One shot: install linux deps + bun, link this checkout in, serve. The anonymous
// volume on /app/node_modules keeps the host's macOS node_modules out of the way.
const boot = [
  'set -e',
  'mkdir -p /cache',
  'echo "[s2] installing bun..." && npm i -g bun --silent',
  'echo "[s2] npm install (linux)..." && npm install --legacy-peer-deps --no-audit --no-fund --silent',
  'ln -sfn /jetplane /app/node_modules/jetplane',
  'echo "[s2] starting jetplane serve..."',
  `node /jetplane/bin/jetplane.mjs serve --port ${PORT}`,
].join(' && ')

console.log('starting container (npm install + cold Metro build inside — expect ~10 min)...')
sh(
  `docker run -d --name ${NAME} -p ${PORT}:${PORT} ` +
  `-v "${DIR}":/app -v /app/node_modules -v "${REPO}":/jetplane ` +
  `-w /app -e JETPLANE_HOME=/cache -e CI=1 node:20-slim bash -c '${boot}'`
)
const logs = () => { try { return sh(`docker logs --tail 15 ${NAME} 2>&1`) } catch { return '(container gone)' } }

try {
  const up = await until(async () => (await fetch(`http://localhost:${PORT}/status`)).ok, 20 * 60_000, 3000)
  record('docker: installs, builds and serves', up)
  if (!up) { console.log(logs()); process.exit(1) }

  const man = await fetch(`http://localhost:${PORT}/`, { headers: { 'expo-platform': 'ios', accept: 'application/expo+json' } })
  let launch = ''
  try { launch = (await man.json()).launchAsset.url } catch {}
  record('docker: ios manifest + launchAsset', man.ok && !!launch)
  const iosB = await fetch(`http://localhost:${PORT}/node_modules/expo-router/entry.bundle?platform=ios&dev=true`)
  const body = iosB.ok ? await iosB.text() : ''
  record('docker: ios bundle serves', iosB.ok && body.length > 1_000_000)
  record('docker: fixture routes in bundle', body.includes('app/(app)/index.tsx') && body.includes('app/(auth)/login.tsx'))

  // HMR with HOST-side writes into the bind mount — the watcher question.
  const orig = fs.readFileSync(SCREEN, 'utf8')
  const upd = await hmrClient(() => fs.writeFileSync(SCREEN, orig + `\n// s2-hmr ${Date.now()}\n`), 'app/(app)/index.tsx')
  fs.writeFileSync(SCREEN, orig)
  await sleep(500)
  record('docker: hmr push on host-side edit', !!upd, upd ? '' : 'no update in 45s — bind-mount inotify gap?')

  const newRoute = path.join(DIR, 'app', 's2-new-route.tsx')
  const upd2 = await hmrClient(() => fs.writeFileSync(newRoute,
    "import { Text } from 'react-native';\nexport default function N(){return <Text>S2</Text>;}\n"), 'app/s2-new-route.tsx')
  fs.rmSync(newRoute, { force: true })
  await sleep(500)
  record('docker: new route file via hmr', !!upd2)
} finally {
  try { sh(`docker rm -f ${NAME}`) } catch {}
}

const fails = results.filter((r) => !r.pass)
console.log(`\n${results.length - fails.length} pass, ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)

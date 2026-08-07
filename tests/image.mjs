// S3 of the local-first pyramid: prebuilt cached image → instant boot + HMR, on the
// host. The docker-side twin of the production flow:
//
//   node tests/image.mjs [--skip-build]
//
//   build:  docker build -f tests/s3.Dockerfile  (bakes scaffold-only, sentinel env)
//   boot:   docker run with the FULL fixture bind-mounted over /app (orchd volume-run),
//           image node_modules preserved via an anonymous volume, real env via -e
//   assert: boot is FAST (no Metro), served bundle carries the post-bake screens and
//           the real env values (sentinels substituted), HMR works on host-side edits
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = path.join(REPO, 'tests', 'fixtures', 'router-app')
const PORT = 8135
const TAG = 'jp-s3:test'
const NAME = 'jp-s3-image'
const SCREEN = path.join(DIR, 'app', '(app)', 'index.tsx')
const ENV = {
  EXPO_PUBLIC_SUPABASE_URL: 'https://s3test-db.example.dev',
  EXPO_PUBLIC_SUPABASE_ANON_KEY: 's3test-anon-key-value',
  EXPO_PUBLIC_API_URL: 'https://s3test-api.example.dev',
}

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
const sh = (cmd, opts = {}) => execSync(cmd, { stdio: 'pipe', cwd: REPO, ...opts }).toString()

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

// 1. build the image (bake inside docker — one cold Metro build, cached by docker layers)
if (!process.argv.includes('--skip-build')) {
  console.log('building prebuilt image (bake inside docker, ~10 min cold)...')
  try {
    execSync(`docker build -f tests/s3.Dockerfile -t ${TAG} .`, { stdio: 'inherit', cwd: REPO })
    record('image: builds with baked bundles', true)
  } catch {
    record('image: builds with baked bundles', false)
    process.exit(1)
  }
}

try { sh(`docker rm -f ${NAME}`) } catch {}

try {
  // 2. boot from the prebuilt image, fixture (WITH screens) bind-mounted over /app
  const t0 = Date.now()
  sh(
    `docker run -d --name ${NAME} -p ${PORT}:${PORT} ` +
    `-v "${DIR}":/app -v /app/node_modules -v "${REPO}":/jetplane:ro ` +
    Object.entries(ENV).map(([k, v]) => `-e ${k}=${v}`).join(' ') +
    ` -e PORT=${PORT} ${TAG}`
  )
  const up = await until(async () => (await fetch(`http://localhost:${PORT}/status`)).ok, 120_000, 500)
  const bootMs = Date.now() - t0
  // First create pays docker's anonymous-volume COPY of the image's node_modules —
  // an infra cost orchd replaces with shared deps extraction + overlayfs (its
  // provision path), not a jetplane cost. Informational here; the FAST assertion is
  // the restart below (= orchd's wake path). A Metro rebuild would blow way past 120s.
  record('boot: image boots to /status (first create, incl. volume copy)', up, `${(bootMs / 1000).toFixed(1)}s`)
  if (!up) { try { console.log(sh(`docker logs --tail 20 ${NAME} 2>&1`)) } catch {} ; process.exit(1) }
  record('boot: no Metro rebuild on boot', !sh(`docker logs ${NAME} 2>&1`).includes('building bundle'),
    'log must not say "building bundle"')

  // 3. served bundle: post-bake screens present, sentinels substituted with real env
  const body = await (await fetch(`http://localhost:${PORT}/node_modules/expo-router/entry.bundle?platform=ios&dev=true`)).text()
  record('bundle: post-bake screens present', body.includes('app/(app)/index.tsx') && body.includes('app/(auth)/login.tsx'))
  record('bundle: env sentinels substituted', body.includes(ENV.EXPO_PUBLIC_SUPABASE_URL) && !body.includes('__ORCHD_ENV_'),
    body.includes('__ORCHD_ENV_') ? 'sentinels left in bundle' : '')

  // 4. HMR on host-side edits through the bind mount
  const orig = fs.readFileSync(SCREEN, 'utf8')
  const upd = await hmrClient(() => fs.writeFileSync(SCREEN, orig + `\n// s3-hmr ${Date.now()}\n`), 'app/(app)/index.tsx')
  fs.writeFileSync(SCREEN, orig)
  await sleep(500)
  record('hmr: host-side edit pushes update', !!upd)

  const newRoute = path.join(DIR, 'app', 's3-new-route.tsx')
  const upd2 = await hmrClient(() => fs.writeFileSync(newRoute,
    "import { Text } from 'react-native';\nexport default function N(){return <Text>S3</Text>;}\n"), 'app/s3-new-route.tsx')
  fs.rmSync(newRoute, { force: true })
  await sleep(500)
  record('hmr: new route file via hmr', !!upd2)

  // 5. suspend/resume shape (= orchd's wake path): restart must be near-instant
  sh(`docker restart ${NAME}`)
  const t1 = Date.now()
  const up2 = await until(async () => (await fetch(`http://localhost:${PORT}/status`)).ok, 60_000, 500)
  record('boot: restart (wake path) is fast', up2 && Date.now() - t1 < 10_000, `${((Date.now() - t1) / 1000).toFixed(1)}s (must be <10s)`)
} finally {
  try { sh(`docker rm -f ${NAME}`) } catch {}
}

const fails = results.filter((r) => !r.pass)
console.log(`\n${results.length - fails.length} pass, ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)

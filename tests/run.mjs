// jetplane local test suite — the release gate.
//
//   node tests/run.mjs [fixture...]     fixtures: plain | router (default: both)
//
// Per fixture: capture completeness (every route file must be a module in the
// captured bundle), the HMR matrix over a fake /hot client, and the serve
// endpoints. Prints a PASS/FAIL/XFAIL matrix; exits non-zero on any non-XFAIL
// failure. Each run uses a throwaway JETPLANE_HOME, so rounds are hermetic
// (~2 min each, all local).
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURES = {
  plain: { dir: path.join(REPO, 'bench', 'expo-app-54'), port: 8131, screen: 'app/(tabs)/index.tsx' },
  router: {
    dir: path.join(REPO, 'tests', 'fixtures', 'router-app'), port: 8132, screen: 'app/(app)/index.tsx',
    // The fixture's stand-ins for AI-generated files (everything a real RapidNative
    // project adds on top of the scaffold the docker image was baked from).
    driftFiles: ['app/(app)/index.tsx', 'app/(auth)/login.tsx'],
  },
}
// Known-unimplemented behaviors: counted separately, never fail the gate.
// Currently EMPTY on purpose: new-route/new-layout/drift are the core RapidNative
// scenario (every real project = scaffold-baked image + AI-added route files), so
// the suite stays red until jetplane handles them. That red IS the release gate.
const XFAIL = new Set([])

const results = []
const record = (fixture, name, pass, detail = '') => {
  const expectedFail = XFAIL.has(name)
  const status = pass ? 'PASS' : expectedFail ? 'XFAIL' : 'FAIL'
  results.push({ fixture, name, status, detail })
  console.log(`  [${status}] ${name}${detail ? ' — ' + detail : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, step = 500) {
  const dl = Date.now() + ms
  while (Date.now() < dl) { if (await fn().catch(() => false)) return true; await sleep(step) }
  return false
}
const get = (url, opts = {}) => fetch(url, opts)

function walkRoutes(dir) {
  const out = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e.name)) out.push(path.relative(dir, p))
    }
  }
  walk(path.join(dir, 'app'))
  return out.map((r) => r.split(path.sep).join('/'))
}

// fake /hot client: resolves with the update FOR expectRel (matched against the
// modified/added sourceURLs), or null on timeout. Matching matters: restore-writes
// from a previous case also push updates, and accepting any update is a false PASS.
function hmrClient(port, editFn, expectRel, timeoutMs = 30000) {
  const want = expectRel.replace(/\.(t|j)sx?$/, '')
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}/hot`)
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

async function runFixture(key) {
  const { dir, port, screen } = FIXTURES[key]
  console.log(`\n=== fixture: ${key} (${dir}) ===`)
  if (!fs.existsSync(path.join(dir, 'node_modules'))) {
    console.log('  installing deps...')
    execSync('npm install --legacy-peer-deps --silent', { cwd: dir, stdio: 'inherit' })
  }
  // jetplane must resolve from the project root; link the repo in for the run
  const link = path.join(dir, 'node_modules', 'jetplane')
  const hadLink = fs.existsSync(link)
  if (!hadLink) fs.symlinkSync(REPO, link)

  const home = fs.mkdtempSync(path.join(os.tmpdir(), `jp-${key}-`))
  const log = path.join(home, 'serve.log')
  const out = fs.openSync(log, 'w')
  // Fail fast if the port is already taken (a leftover server would make every
  // assertion below test the WRONG process).
  try {
    execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, { stdio: 'ignore' })
    throw new Error(`port ${port} already in use — kill the leftover server first`)
  } catch (e) { if (!/exited with|Command failed/.test(String(e))) throw e }

  // detached => own process group, so cleanup kills the CLI AND the bun thin
  // server it spawns (kill(pid) alone orphans the child).
  const srv = spawn('node', [path.join(REPO, 'bin', 'jetplane.mjs'), 'serve', '--port', String(port)], {
    cwd: dir, env: { ...process.env, JETPLANE_HOME: home }, stdio: ['ignore', out, out], detached: true,
  })
  const cleanup = () => { try { process.kill(-srv.pid) } catch {} ; if (!hadLink) fs.rmSync(link, { force: true }) }
  process.on('exit', cleanup)

  try {
    const up = await until(async () => (await get(`http://localhost:${port}/status`)).ok, 8 * 60_000, 2000)
    record(key, 'serve: builds and comes up', up)
    if (!up) { console.log(fs.readFileSync(log, 'utf8').split('\n').slice(-12).join('\n')); return }

    // --- A. capture completeness ---
    const imgRoot = path.join(home, '.jetplane', 'images')
    const imgDir = path.join(imgRoot, fs.readdirSync(imgRoot)[0])
    for (const f of ['main.ios.bundle', 'manifest.ios.json', 'manifest-multipart.ios.bin']) {
      record(key, `capture: ${f} exists`, fs.existsSync(path.join(imgDir, f)))
    }
    const { parseBundle } = await import(path.join(REPO, 'src', 'jetplane-hmr.mjs'))
    const maps = parseBundle(path.join(imgDir, 'main.ios.bundle'))
    const routes = walkRoutes(dir)
    const missing = routes.filter((r) => !maps.pathToId.has(r))
    record(key, 'capture: every route file is a module in the ios bundle', missing.length === 0,
      missing.length ? `missing: ${missing.join(', ')}` : `${routes.length} route files present`)

    // --- C. endpoints (before HMR mutates files) ---
    const man = await get(`http://localhost:${port}/`, { headers: { 'expo-platform': 'ios', accept: 'application/expo+json' } })
    let launch = ''
    try { launch = (await man.json()).launchAsset.url } catch {}
    record(key, 'endpoint: ios manifest json + launchAsset', man.ok && !!launch, launch.slice(0, 60))
    const multi = await get(`http://localhost:${port}/`, { headers: { 'expo-platform': 'ios', 'expo-protocol-version': '1', accept: 'multipart/mixed' } })
    record(key, 'endpoint: ios manifest multipart', multi.ok && (multi.headers.get('content-type') || '').includes('multipart'))
    const iosB = await get(`http://localhost:${port}/node_modules/expo-router/entry.bundle?platform=ios&dev=true`)
    record(key, 'endpoint: ios bundle', iosB.ok && (await iosB.arrayBuffer()).byteLength > 1_000_000)
    const webB = await get(`http://localhost:${port}/anything.bundle?platform=web`)
    record(key, 'endpoint: *.bundle platform=web parity', webB.ok)
    const msgOk = await new Promise((res) => {
      const ws = new WebSocket(`ws://localhost:${port}/message`)
      const t = setTimeout(() => res(false), 5000)
      ws.onopen = () => { clearTimeout(t); ws.close(); res(true) }
      ws.onerror = () => { clearTimeout(t); res(false) }
    })
    record(key, 'endpoint: /message socket accepted', msgOk)

    // --- B. HMR matrix ---
    const screenAbs = path.join(dir, screen)
    const orig = fs.readFileSync(screenAbs, 'utf8')
    const upd = await hmrClient(port, () => fs.writeFileSync(screenAbs, orig + `\n// hmr ${Date.now()}\n`), screen)
    fs.writeFileSync(screenAbs, orig)
    await sleep(500) // let the restore-write's own push drain before the next case
    record(key, 'hmr: edit existing screen pushes update', !!upd, upd ? `module ${upd.modified?.[0]?.module?.[0]}` : 'no update in 30s')

    const newRoute = path.join(dir, 'app', 'hmr-new-route.tsx')
    const upd2 = await hmrClient(port, () => fs.writeFileSync(newRoute,
      "import { Text } from 'react-native';\nexport default function N(){return <Text>NEW</Text>;}\n"), 'app/hmr-new-route.tsx')
    record(key, 'hmr: new route file appears', !!upd2)

    const newLayout = path.join(dir, 'app', 'hmr-group')
    fs.mkdirSync(newLayout, { recursive: true })
    const upd3 = await hmrClient(port, () => fs.writeFileSync(path.join(newLayout, '_layout.tsx'),
      "import { Slot } from 'expo-router';\nexport default function L(){return <Slot/>;}\n"), 'app/hmr-group/_layout.tsx')
    record(key, 'hmr: new layout file applies', !!upd3)
    fs.rmSync(newRoute, { force: true }); fs.rmSync(newLayout, { recursive: true, force: true })
    await sleep(500)

    // edit-existing must still work after the new-file noise
    const upd4 = await hmrClient(port, () => fs.writeFileSync(screenAbs, orig + `\n// hmr2 ${Date.now()}\n`), screen)
    fs.writeFileSync(screenAbs, orig)
    await sleep(500)
    record(key, 'hmr: edit still works after new-file events', !!upd4)

    // --- server log hygiene ---
    const logTxt = fs.readFileSync(log, 'utf8')
    const bad = logTxt.split('\n').filter((l) => /error|unhandled|traceback/i.test(l) && !/skip |web capture skipped/.test(l))
    record(key, 'log: no errors in server output', bad.length === 0, bad.slice(0, 2).join(' | '))

    // --- F. an AI-style app.json rewrite must NOT invalidate the cached bundle ---
    // RapidNative's agent rewrites app.json WHOLESALE: rename, restyled splash inside
    // `plugins`, and it drops fields it doesn't know about (experiments, newArchEnabled,
    // sdkVersion — observed in production, project alekib6w3w). None of that changes
    // the dev bundle, so a reboot on the same cache must serve cached and surface the
    // new name in the manifest. A rebuild here is the "expo server froze for minutes"
    // bug.
    try { process.kill(-srv.pid) } catch {}
    await until(async () => !(await get(`http://localhost:${port}/status`).then(() => true).catch(() => false)), 15_000, 500)
    const appJsonPath = path.join(dir, 'app.json')
    const appJsonOrig = fs.readFileSync(appJsonPath, 'utf8')
    const renamed = JSON.parse(appJsonOrig)
    const exp = renamed.expo ?? renamed
    exp.name = `Renamed ${Date.now()}`
    delete exp.experiments
    delete exp.newArchEnabled
    delete exp.sdkVersion
    if (Array.isArray(exp.plugins)) {
      exp.plugins = exp.plugins.map((p) =>
        Array.isArray(p) && p[0] === 'expo-splash-screen' ? [p[0], { ...p[1], backgroundColor: '#fefce8' }] : p)
    }
    fs.writeFileSync(appJsonPath, JSON.stringify(renamed, null, 2))
    const log2 = path.join(home, 'serve-rename.log')
    const out2 = fs.openSync(log2, 'w')
    const srv2 = spawn('node', [path.join(REPO, 'bin', 'jetplane.mjs'), 'serve', '--port', String(port)], {
      cwd: dir, env: { ...process.env, JETPLANE_HOME: home }, stdio: ['ignore', out2, out2], detached: true,
    })
    try {
      const upR = await until(async () => (await get(`http://localhost:${port}/status`)).ok, 45_000, 1000)
      const log2Txt = fs.readFileSync(log2, 'utf8')
      record(key, 'rename: boots from cache (no rebuild)', upR && !log2Txt.includes('building bundle'),
        log2Txt.includes('building bundle') ? 'rebuild triggered by app.json rename' : upR ? '' : 'server did not come up in 45s')
      if (upR) {
        const manR = await (await get(`http://localhost:${port}/`, { headers: { 'expo-platform': 'ios', accept: 'application/expo+json' } })).text()
        record(key, 'rename: manifest carries new name', manR.includes((renamed.expo ?? renamed).name))
      }
    } finally {
      try { process.kill(-srv2.pid) } catch {}
      fs.writeFileSync(appJsonPath, appJsonOrig)
    }
    await until(async () => !(await get(`http://localhost:${port}/status`).then(() => true).catch(() => false)), 15_000, 500)

    // --- G. REAL config drift must serve stale instantly + rebuild in background ---
    // Changing global.css genuinely invalidates the family (nativewind input). Boot
    // must still be instant — serving the newest image — with the fresh build running
    // BEHIND the server, never in front of it.
    const cssPath = path.join(dir, 'global.css')
    const cssOrig = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : null
    if (cssOrig != null) {
      fs.writeFileSync(cssPath, cssOrig + `\n/* drift ${Date.now()} */\n`)
      const log3 = path.join(home, 'serve-drift.log')
      const out3 = fs.openSync(log3, 'w')
      const srv3 = spawn('node', [path.join(REPO, 'bin', 'jetplane.mjs'), 'serve', '--port', String(port)], {
        cwd: dir, env: { ...process.env, JETPLANE_HOME: home }, stdio: ['ignore', out3, out3], detached: true,
      })
      try {
        const t0 = Date.now()
        const upS = await until(async () => (await get(`http://localhost:${port}/status`)).ok, 45_000, 1000)
        const bootS = (Date.now() - t0) / 1000
        const log3Txt = () => fs.readFileSync(log3, 'utf8')
        record(key, 'config-drift: serves stale instantly', upS && log3Txt().includes('despite config drift') && bootS < 30,
          upS ? `${bootS.toFixed(1)}s` : 'server did not come up')
        const rebuilt = await until(async () => /background rebuild (done|failed)/.test(log3Txt()), 8 * 60_000, 5000)
        record(key, 'config-drift: background rebuild completes', rebuilt && log3Txt().includes('background rebuild done'),
          (log3Txt().match(/background rebuild.*$/m) || [''])[0])
      } finally {
        try { process.kill(-srv3.pid) } catch {}
        fs.writeFileSync(cssPath, cssOrig)
      }
    }
  } finally {
    cleanup()
  }
}

// --- E. bake→boot drift (the orchd/RapidNative production shape) ---
// Bake an image WITHOUT the AI-generated screens (= scaffold, what orchd bakes into
// docker images), then restore the screens (= orchd syncing the project delta at boot)
// and serve from the STALE image dir exactly like orchd does (explicit imageDir arg,
// no rebuild). The served bundle must still contain the added routes, and HMR must
// work for them.
async function runDrift(key) {
  const { dir, port, screen, driftFiles } = FIXTURES[key]
  console.log(`\n=== drift: ${key} ===`)
  const saved = new Map()
  for (const rel of driftFiles) {
    const abs = path.join(dir, rel)
    saved.set(abs, fs.readFileSync(abs, 'utf8'))
    fs.rmSync(abs)
  }
  const restore = () => { for (const [abs, src] of saved) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, src) } }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), `jp-drift-${key}-`))
  const log = path.join(home, 'serve.log')
  let srv = null
  const kill = () => { if (srv) try { process.kill(-srv.pid) } catch {} ; srv = null }
  process.on('exit', () => { kill(); restore() })
  try {
    // 1. bake: capture the scaffold-only image, then stop the server
    let out = fs.openSync(log, 'w')
    srv = spawn('node', [path.join(REPO, 'bin', 'jetplane.mjs'), 'serve', '--port', String(port)], {
      cwd: dir, env: { ...process.env, JETPLANE_HOME: home }, stdio: ['ignore', out, out], detached: true,
    })
    const baked = await until(async () => (await get(`http://localhost:${port}/status`)).ok, 8 * 60_000, 2000)
    kill()
    record(key, 'drift: scaffold-only image bakes', baked)
    if (!baked) { console.log(fs.readFileSync(log, 'utf8').split('\n').slice(-12).join('\n')); return }
    const imgRoot = path.join(home, '.jetplane', 'images')
    const imageDir = path.join(imgRoot, fs.readdirSync(imgRoot)[0])
    await until(async () => !(await get(`http://localhost:${port}/status`).then(() => true).catch(() => false)), 15_000, 500)

    // 2. boot: restore the delta and serve from the stale image, orchd-style
    restore()
    out = fs.openSync(log, 'a')
    srv = spawn('bun', [path.join(REPO, 'src', 'jetplane-serve-thin.ts'), dir, String(port), imageDir], {
      cwd: dir, env: { ...process.env, JETPLANE_HOME: home }, stdio: ['ignore', out, out], detached: true,
    })
    const up = await until(async () => (await get(`http://localhost:${port}/status`)).ok, 60_000, 1000)
    record(key, 'drift: thin-serve boots from stale image', up)
    if (!up) { console.log(fs.readFileSync(log, 'utf8').split('\n').slice(-12).join('\n')); return }

    // 3. served bundle must include the post-bake route files
    const body = await (await get(`http://localhost:${port}/node_modules/expo-router/entry.bundle?platform=ios&dev=true`)).text()
    const tmpBundle = path.join(home, 'served.ios.bundle')
    fs.writeFileSync(tmpBundle, body)
    const { parseBundle } = await import(path.join(REPO, 'src', 'jetplane-hmr.mjs'))
    const servedMaps = parseBundle(tmpBundle)
    const absent = driftFiles.filter((r) => !servedMaps.pathToId.has(r))
    record(key, 'drift: added routes present in served bundle', absent.length === 0,
      absent.length ? `missing: ${absent.join(', ')}` : `${driftFiles.length} delta files present`)

    // nativewind: tailwind classes used ONLY by post-bake screens must reach the
    // compiled registry (regenerated async at boot — poll). Without this the added
    // screens hot-load but render UNSTYLED (the production symptom).
    const cssOk = await until(async () => {
      const b = await (await get(`http://localhost:${port}/node_modules/expo-router/entry.bundle?platform=ios&dev=true`)).text()
      return b.includes('"mb-6"') && b.includes('"text-2xl"')
    }, 60_000, 3000)
    record(key, 'drift: post-bake tailwind classes in css registry', cssOk, cssOk ? '' : 'mb-6/text-2xl never appeared (registry not refreshed)')

    // 4. HMR on a post-bake file
    const abs = path.join(dir, screen)
    const orig = fs.readFileSync(abs, 'utf8')
    const upd = await hmrClient(port, () => fs.writeFileSync(abs, orig + `\n// drift-hmr ${Date.now()}\n`), screen)
    fs.writeFileSync(abs, orig)
    record(key, 'drift: hmr works on post-bake file', !!upd)

    // 5. BURST of new route files against the RUNNING server — how orchd
    // write-through delivers an AI edit: several files landing ~seconds apart.
    // Racing update passes used to silently drop some of them (production bug:
    // 2 of 4 screens missing). Every file must reach the served bundle.
    const burst = ['app/burst-a.tsx', 'app/burst-b.tsx', 'app/(app)/burst-c.tsx']
    for (const [i, rel] of burst.entries()) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      fs.writeFileSync(path.join(dir, rel),
        `import { Text } from 'react-native';\nexport default function B${i}(){ return <Text>BURST ${i}</Text>; }\n`)
      await sleep(400)
    }
    const burstOk = await until(async () => {
      const b = await (await get(`http://localhost:${port}/node_modules/expo-router/entry.bundle?platform=ios&dev=true`)).text()
      return burst.every((r) => b.includes(r))
    }, 120_000, 3000)
    for (const rel of burst) fs.rmSync(path.join(dir, rel), { force: true })
    record(key, 'drift: burst of new files all reach served bundle', burstOk)
  } finally {
    kill()
    restore()
  }
}

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(FIXTURES)
for (const f of wanted) {
  await runFixture(f)
  if (FIXTURES[f].driftFiles) await runDrift(f)
}

console.log('\n=== matrix ===')
for (const r of results) console.log(`${r.status.padEnd(5)} ${r.fixture.padEnd(7)} ${r.name}`)
const fails = results.filter((r) => r.status === 'FAIL')
console.log(`\n${results.filter(r=>r.status==='PASS').length} pass, ${fails.length} fail, ${results.filter(r=>r.status==='XFAIL').length} xfail`)
process.exit(fails.length ? 1 : 0)

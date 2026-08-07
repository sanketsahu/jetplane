// `jetplane start` — one command for the thin dev server.
//
//   1. ensure the transform-cache plugin is wired into metro.config.js
//   2. ensure dependencies are installed
//   3. ensure a device-bootable bundle exists for this lockfile (build once via Metro)
//   4. serve it from the thin, no-Metro server (Bun) + print a QR
//
// The thin server + build step are experimental and need Bun; the plugin step alone works
// on plain Node (that's what `jetplane init` does).

import { spawn, execSync, execFileSync } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOME = process.env.JETPLANE_HOME || os.homedir()
const log = (m) => console.log(`jetplane: ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const has = (cmd) => { try { execSync(`command -v ${cmd}`, { stdio: 'ignore' }); return true } catch { return false } }

// Ask the OS for a free port (bind :0, read the assigned port, release). We never claim a
// hardcoded port or kill whatever holds it — several projects can build concurrently.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

const DEFAULT_CONFIG = `const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// jetplane wraps whatever transformer is already configured (here Expo's default) so its
// behavior is preserved — jetplane only adds a cross-project cache around it.
config.transformer.upstreamTransformerPath = config.transformerPath;
config.transformerPath = require.resolve('jetplane/transformer');
config.cacheStores = [];

module.exports = config;
`

// The wiring appended before module.exports. Binds the FINAL exported config to a temp
// first, so it works whether the export is a bare identifier (module.exports = config)
// or a call that builds the final config (module.exports = withNativeWind(config, ...)).
// Capturing the existing transformerPath as the upstream is what keeps NativeWind's .css
// handling (and Expo's asset worker) working — jetplane delegates to it.
function wiringBlock(expr) {
  return `const __jetplaneConfig = ${expr};
__jetplaneConfig.transformer = __jetplaneConfig.transformer || {};
__jetplaneConfig.transformer.upstreamTransformerPath = __jetplaneConfig.transformerPath;
__jetplaneConfig.transformerPath = require.resolve('jetplane/transformer');
__jetplaneConfig.cacheStores = [];
module.exports = __jetplaneConfig;
`
}

// 1. ensure metro.config.js wires in the plugin
export function ensureConfig(dir) {
  const cfg = path.join(dir, 'metro.config.js')
  let s = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf8') : null
  if (s?.includes('jetplane/transformer')) { log('plugin already in metro.config.js'); return }

  // Never write wiring the project can't resolve. The line we add is
  // require.resolve('jetplane/transformer'), so without a local install Metro dies loading
  // its own config — and that breaks plain `expo start` too, not just jetplane.
  if (!jetplaneResolvable(dir)) throw notInstalledError(dir)

  if (s === null) { fs.writeFileSync(cfg, DEFAULT_CONFIG); log('created metro.config.js with the jetplane plugin'); return }
  const idx = s.lastIndexOf('module.exports')
  const eq = idx > -1 ? s.indexOf('=', idx) : -1
  if (eq > -1) {
    let expr = s.slice(eq + 1).trim()
    // strip a trailing semicolon + any trailing whitespace/newlines on the statement
    if (expr.endsWith(';')) expr = expr.slice(0, -1).trim()
    s = s.slice(0, idx) + wiringBlock(expr)
    fs.writeFileSync(cfg, s)
    log('added the jetplane plugin to metro.config.js')
  } else {
    log("could not auto-edit metro.config.js — before module.exports add:\n  config.transformer.upstreamTransformerPath = config.transformerPath;\n  config.transformerPath = require.resolve('jetplane/transformer');\n  config.cacheStores = [];")
  }
}

// 2. ensure deps
function ensureInstalled(dir) {
  if (fs.existsSync(path.join(dir, 'node_modules'))) return
  const inst = has('bun') ? 'bun install' : has('pnpm') ? 'pnpm install' : 'npm install'
  log(`installing dependencies (${inst.split(' ')[0]})...`)
  execSync(inst, { cwd: dir, stdio: 'inherit' })
}

// Cache key for a built bundle IMAGE. The cross-project transform cache is keyed by source
// bytes (shared across projects — that's the point). A bundle image is different: it contains
// THIS app's own source, so it must be keyed per project. Keying it on the lockfile alone
// (lockHash) collides for two projects with identical deps — the second serves the first's
// app. So mix in the project path, bundle-affecting config, and the app source tree; editing
// app code also invalidates the image, so a fresh `serve` rebuilds instead of serving stale.
function imageKey(dir) {
  const h = crypto.createHash('sha256')
  h.update(path.resolve(dir))
  const add = (p) => { try { if (fs.statSync(p).isFile()) h.update(fs.readFileSync(p)) } catch {} }
  for (const f of ['bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']) {
    const p = path.join(dir, f); if (fs.existsSync(p)) { add(p); break }
  }
  for (const f of ['app.json', 'app.config.js', 'app.config.ts', 'metro.config.js', 'babel.config.js', 'global.css', 'tailwind.config.js']) add(path.join(dir, f))
  const walk = (d) => {
    let ents
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else { h.update(path.relative(dir, p)); add(p) }
    }
  }
  for (const s of ['app', 'components', 'src', 'constants', 'hooks']) walk(path.join(dir, s))
  return h.digest('hex').slice(0, 16)
}

// Can the PROJECT resolve 'jetplane/transformer'? That is what metro.config.js does, and
// Metro resolves it from the project root — running the CLI through npx doesn't put
// jetplane there, so Metro would die on an unresolvable require before it ever serves.
//
// The check runs in a CHILD process on purpose: Node caches package.json lookups for the
// lifetime of a process, so an in-process check that ran before an install keeps reporting
// 'missing' afterwards, making a successful auto-install look like a failure.
export function jetplaneResolvable(dir) {
  const script = `require('node:module').createRequire(process.argv[1]).resolve('jetplane/transformer')`
  try {
    execFileSync(process.execPath, ['-e', script, path.join(dir, 'package.json')], { stdio: 'ignore' })
    return true
  } catch { return false }
}

export function notInstalledError(dir) {
  return new Error(
    `jetplane is not installed in this project (${dir}).\n\n` +
    `Metro resolves 'jetplane/transformer' from the project root, so running the CLI via npx\n` +
    `is not enough — jetplane has to be a dependency here:\n\n  npm install -D jetplane\n\n` +
    `(then re-run; the CLI itself can still be invoked with npx.)`
  )
}

function ensureResolvable(dir) {
  const cfg = path.join(dir, 'metro.config.js')
  if (!fs.existsSync(cfg)) return
  if (!fs.readFileSync(cfg, 'utf8').includes('jetplane/transformer')) return
  if (!jetplaneResolvable(dir)) throw notInstalledError(dir)
}

// `dev` is the unified fresh-project command and already installs dependencies, so when
// jetplane itself is missing from the project it installs that too rather than stopping.
// It must run BEFORE the config is written: writing wiring the project cannot resolve
// breaks plain `expo start` as well, leaving the project worse off than before.
function ensureJetplaneDep(dir) {
  if (jetplaneResolvable(dir)) return
  const version = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version
  const spec = `jetplane@${version}`
  const cmd = has('bun') ? `bun add -d ${spec}` : has('pnpm') ? `pnpm add -D ${spec}` : `npm install -D ${spec}`
  log(`jetplane is not a dependency of this project — Metro resolves the transformer from`)
  log(`the project root, so installing it here (${cmd})...`)
  try {
    execSync(cmd, { cwd: dir, stdio: 'inherit' })
  } catch {
    // The installer printed its own reason above. The version is pinned to this CLI's, so
    // the usual cause is that version not being on the registry (a local or prerelease
    // build) — say so rather than repeating 'not installed'.
    throw new Error(
      `could not install ${spec} into this project (see the installer output above).\n\n` +
      `jetplane pins the transformer to the CLI's own version so the two can't drift.\n` +
      `If ${spec} isn't published, install a version that is:\n\n  npm install -D jetplane\n`
    )
  }
  if (!jetplaneResolvable(dir)) throw notInstalledError(dir)
  log(`installed ${spec}`)
}

// Prefer the project's own expo binary over `npx expo`. `npx` inside an npx-run CLI can
// resolve against the wrong root (or go to the network), and it hides a missing dep behind
// an install attempt instead of a clear error.
function expoCommand(dir) {
  const local = path.join(dir, 'node_modules', '.bin', process.platform === 'win32' ? 'expo.cmd' : 'expo')
  return fs.existsSync(local) ? [local, []] : ['npx', ['expo']]
}

function metroFailure(label, isNpx, out) {
  const tail = out.slice(-25).join('\n')
  const hint = isNpx
    ? `\n\nNo local expo binary was found in node_modules/.bin — is 'expo' a dependency of this project, and are deps installed?`
    : ''
  return `Metro did not start (temporary build server).\n\n--- output from '${label}' ---\n${tail || '(no output)'}\n--- end of output ---${hint}`
}

async function get(url, ms, headers = {}) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms)
  try { const r = await fetch(url, { signal: c.signal, headers }); return { ok: r.ok, status: r.status, body: await r.text() } }
  catch (e) { return { ok: false, status: 0, body: '', error: e?.name === 'AbortError' ? `timed out after ${ms}ms` : e.message } }
  finally { clearTimeout(t) }
}

// Metro answers a failed bundle with a JSON error body (TransformError, resolution
// failures, …). That body names the file and line — surface it instead of collapsing
// every cause into 'bundle request failed'.
function bundleFailure(res) {
  if (res.error) return `bundle request failed (${res.error})`
  let detail = res.body?.slice(0, 2000) || '(empty response)'
  try {
    const j = JSON.parse(res.body)
    // strip the ANSI-art code frame; the message + location is the useful part
    const where = j.filename ? ` in ${j.filename}${j.lineNumber ? `:${j.lineNumber}` : ''}` : ''
    if (j.message) detail = `${j.type || j.name || 'Error'}${where}\n${String(j.message).split('\n')[0]}`
  } catch {}
  return `bundle request failed (HTTP ${res.status})\n\n--- Metro said ---\n${detail}\n--- end ---`
}

// 3. build the device-bootable bundle by capturing it from Metro once (cached per project +
// app source via imageKey — NOT per lockfile, which would collide across same-dep projects)
// Every native platform is captured separately. A bundle is platform-specific — module ids
// and native module registrations differ — so serving the iOS bundle to an Android client
// (which is what a single-platform image forced) cannot work.
const NATIVE_PLATFORMS = ['ios', 'android']

// Family key: deps + bundle-affecting config, NO app source and NO project path. Two
// trees in the same family differ only in app source — which the thin server reconciles
// at boot (freshening) — so a family match is servable without a Metro rebuild.
function familyKey(dir) {
  const h = crypto.createHash('sha256')
  const add = (p) => { try { if (fs.statSync(p).isFile()) h.update(fs.readFileSync(p)) } catch {} }
  for (const f of ['bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']) {
    const p = path.join(dir, f); if (fs.existsSync(p)) { add(p); break }
  }
  for (const f of ['app.json', 'app.config.js', 'app.config.ts', 'metro.config.js', 'babel.config.js', 'global.css', 'tailwind.config.js']) add(path.join(dir, f))
  return h.digest('hex').slice(0, 16)
}

async function ensureBundle(dir) {
  const imageDir = path.join(HOME, '.jetplane', 'images', imageKey(dir))
  const required = NATIVE_PLATFORMS.flatMap((p) => [`main.${p}.bundle`, `manifest-multipart.${p}.bin`, `manifest.${p}.json`])
  const complete = (d) => required.every((f) => fs.existsSync(path.join(d, f)))
  if (complete(imageDir)) {
    // Web is captured best-effort, so it must not gate completeness — a failed
    // web capture used to force a full rebuild on every boot, forever.
    if (!fs.existsSync(path.join(imageDir, 'main.web.bundle'))) log('note: no web bundle in this image (web capture skipped at build)')
    log(`bundle cached (${path.relative(HOME, imageDir)})`); return imageDir
  }
  // Exact miss (the app source changed since the image was built). A same-FAMILY image
  // — same deps + config — is still servable: the thin server reconciles source drift
  // at boot. This is the production path: docker images are baked from the template
  // scaffold, and every real project's tree differs from it the moment files are added.
  // Rebuilding here instead would turn every boot into a cold Metro build.
  const fam = familyKey(dir)
  const imagesRoot = path.join(HOME, '.jetplane', 'images')
  let best = null
  for (const name of fs.existsSync(imagesRoot) ? fs.readdirSync(imagesRoot) : []) {
    const d = path.join(imagesRoot, name)
    const famFile = path.join(d, 'family.json')
    try {
      if (JSON.parse(fs.readFileSync(famFile, 'utf8')).family !== fam || !complete(d)) continue
      const mtime = fs.statSync(famFile).mtimeMs
      if (!best || mtime > best.mtime) best = { d, mtime }
    } catch {}
  }
  if (best) {
    log(`serving same-family image ${path.relative(HOME, best.d)} — app source drift is reconciled at boot`)
    return best.d
  }
  fs.mkdirSync(imageDir, { recursive: true })
  log('building bundle (running Metro once — this is the one-time build)...')

  // Bring up a temporary Metro on an OS-assigned free port. If it doesn't come up (e.g. the
  // port was grabbed between probe and bind, or another build raced us), retry on a fresh
  // port instead of stomping on whatever is listening.
  let metro, port, base
  for (let attempt = 1; ; attempt++) {
    port = await freePort()
    const [cmd, pre] = expoCommand(dir)
    const label = [cmd === 'npx' ? 'npx' : path.relative(dir, cmd), ...pre, 'start'].join(' ')
    // Keep Metro's output instead of discarding it: when the build server fails to come
    // up, its stderr is the only thing that says why, and 'Metro did not start' on its
    // own is undiagnosable.
    const buildEnv = { ...process.env, CI: '1' }
    // The capture Metro serves only this build; proxied/public origins would
    // leak into the manifests it emits (and can even route back to a server
    // that is mid-provision behind a gateway).
    delete buildEnv.EXPO_PACKAGER_PROXY_URL
    delete buildEnv.REACT_NATIVE_PACKAGER_HOSTNAME
    // The captured bundle must be self-contained: expo-router's import mode
    // decides whether route screens are statically required into the bundle
    // (its default varies by version/platform), and lazily-imported routes
    // become deferred chunks nobody captures — navigation breaks and HMR has
    // no module ids for screens. Callers can still override explicitly.
    if (!buildEnv.EXPO_ROUTER_IMPORT_MODE) buildEnv.EXPO_ROUTER_IMPORT_MODE = 'sync'
    metro = spawn(cmd, [...pre, 'start', '--port', String(port)], { cwd: dir, env: buildEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    const collect = (b) => { for (const l of String(b).split('\n')) if (l.trim()) { out.push(l); if (out.length > 60) out.shift() } }
    metro.stdout.on('data', collect)
    metro.stderr.on('data', collect)
    metro.on('error', (e) => collect(`spawn ${cmd}: ${e.message}`))

    base = `http://localhost:${port}/`
    const dl = Date.now() + 180000
    let up = false, died = false
    while (Date.now() < dl) {
      if (metro.exitCode != null || metro.signalCode != null) { died = true; break }
      const r = await get(base + 'status', 2000)
      if (r.ok && r.body.includes('running')) { up = true; break }
      await sleep(500)
    }
    if (up) break
    try { process.kill(-metro.pid, 'SIGKILL') } catch {}

    // Retrying only helps for a port race. If Metro exited on its own and never mentioned
    // the port, a fresh port will fail identically — report the real output now.
    const portRace = out.some((l) => /EADDRINUSE|address already in use|port \d+ is (?:already )?(?:in use|running)/i.test(l))
    if (died && !portRace) throw new Error(metroFailure(label, cmd === 'npx', out))
    if (attempt >= 3) throw new Error(metroFailure(label, cmd === 'npx', out))
    log(`build server didn't come up on :${port} — retrying on a fresh port...`)
    await sleep(500)
  }
  const kill = () => { try { process.kill(-metro.pid, 'SIGKILL') } catch {} }
  try {
    for (const platform of NATIVE_PLATFORMS) {
      const json = (await get(base, 20000, { 'expo-platform': platform, Accept: 'application/expo+json,application/json' })).body
      fs.writeFileSync(path.join(imageDir, `manifest.${platform}.json`), json)
      const multi = (await get(base, 20000, { 'expo-platform': platform, 'expo-protocol-version': '1', Accept: 'multipart/mixed,application/expo+json,application/json' })).body
      fs.writeFileSync(path.join(imageDir, `manifest-multipart.${platform}.bin`), multi)
      let url
      try { url = JSON.parse(json).launchAsset.url } catch { throw new Error(`could not read the ${platform} manifest from Metro:\n${json.slice(0, 500)}`) }
      // Fetch through the local Metro regardless of what the manifest says: a
      // proxy env (EXPO_PACKAGER_PROXY_URL) makes launchAsset point at a public
      // origin that may route back to the very server being provisioned.
      // And force lazy=false: with lazy bundling the entry bundle omits route
      // screens (they'd be deferred chunks nobody captures), which both breaks
      // the served app's navigation and leaves HMR without module ids for any
      // screen file. Web capture below already does the same.
      url = new URL(new URL(url).pathname + new URL(url).search, base).toString()
      url = url.replace(/([?&])lazy=true/, '$1lazy=false')
      if (!/[?&]lazy=/.test(url)) url += (url.includes('?') ? '&' : '?') + 'lazy=false'
      log(`bundling ${platform} (first build may take a moment)...`)
      const bundle = await get(url, 180000)
      if (!bundle.ok) throw new Error(`[${platform}] ${bundleFailure(bundle)}`)
      fs.writeFileSync(path.join(imageDir, `main.${platform}.bundle`), bundle.body)
      log(`${platform} bundle built (${(bundle.body.length / 1048576).toFixed(1)} MB)`)
    }

    // web: capture the HTML shell + a self-contained (lazy=false) web bundle, so the
    // thin server can serve the browser target the same way it serves the device.
    try {
      const html = (await get(base, 30000, { Accept: 'text/html' })).body
      const m = html && html.match(/<script[^>]*src="([^"]*\.bundle[^"]*)"/)
      if (m) {
        let webUrl = m[1].replace(/([?&])lazy=true/, '$1lazy=false')
        if (!/[?&]lazy=/.test(webUrl)) webUrl += (webUrl.includes('?') ? '&' : '?') + 'lazy=false'
        const abs = webUrl.startsWith('http') ? webUrl : base.replace(/\/$/, '') + webUrl
        log('building web bundle...')
        const web = await get(abs, 180000)
        if (web.ok) {
          fs.writeFileSync(path.join(imageDir, 'index.html'), html.replace(m[1], '/jetplane-web.bundle'))
          fs.writeFileSync(path.join(imageDir, 'main.web.bundle'), web.body)
          log('web bundle + html captured')
        } else log('web capture skipped (bundle request failed)')
      } else log('web capture skipped (no web entry in HTML — is react-native-web installed?)')
    } catch (e) { log(`web capture skipped (${e.message})`) }

    // Bake manifest: rel -> sha256 of every app source file AT CAPTURE TIME. The thin
    // server diffs this against the project on boot to re-transform files that changed
    // after the image was baked (added/removed route files are detected without it).
    const manifest = {}
    for (const root of ['app', 'components', 'src', 'constants', 'hooks']) {
      const walk = (d) => {
        let ents
        try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
        for (const e of ents) {
          if (e.name.startsWith('.')) continue
          const p = path.join(d, e.name)
          if (e.isDirectory()) walk(p)
          else if (/\.[tj]sx?$/.test(e.name) && !e.name.endsWith('.d.ts')) {
            manifest[path.relative(dir, p).split(path.sep).join('/')] =
              crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
          }
        }
      }
      walk(path.join(dir, root))
    }
    fs.writeFileSync(path.join(imageDir, 'files.json'), JSON.stringify(manifest))
    fs.writeFileSync(path.join(imageDir, 'family.json'), JSON.stringify({ family: familyKey(dir) }))

    return imageDir
  } finally { kill(); await sleep(500) }
}

// 4. serve it from the thin server (Bun)
function serveThin(dir, port, imageDir, explicitPort = false) {
  if (!has('bun')) { console.error('jetplane: the thin server needs Bun — install it from https://bun.sh, then re-run.'); process.exit(1) }
  const thin = path.join(HERE, 'jetplane-serve-thin.ts')
  // A port the user asked for is strict — see the CLI note. Only an unrequested default
  // is allowed to drift to the next free port.
  const env = { ...process.env, JETPLANE_STRICT_PORT: explicitPort ? '1' : '' }
  const child = spawn('bun', [thin, dir, String(port), imageDir], { stdio: 'inherit', env })
  child.on('exit', (c) => process.exit(c ?? 0))
}

// `jetplane serve` — thin server only. Assumes the project is already set up (plugin
// wired, deps installed); builds the bundle if it's missing, then serves it.
export async function serve({ dir = process.cwd(), port = 8091, explicit = false } = {}) {
  log(`serving ${dir}`)
  ensureResolvable(dir)
  const imageDir = await ensureBundle(dir)
  serveThin(dir, port, imageDir, explicit)
}

// `jetplane dev` (alias `start`) — the unified one-liner for a fresh project:
// install deps, make jetplane resolvable from the project, wire the plugin, build the
// bundle once, then serve it. Order matters: deps must exist before jetplane can be added
// to them, and jetplane must resolve before its wiring is written into metro.config.js.
export async function start({ dir = process.cwd(), port = 8091, explicit = false } = {}) {
  log(`starting in ${dir}`)
  ensureInstalled(dir)
  ensureJetplaneDep(dir)
  ensureConfig(dir)
  const imageDir = await ensureBundle(dir)
  serveThin(dir, port, imageDir, explicit)
}

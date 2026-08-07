#!/usr/bin/env bun
// Path-2 MEMORY FUSION: serve a PRE-BUILT (cross-project-cached) device-bootable bundle
// to Expo Go over the dev protocol, with NO per-project Metro. Bundle is mmap'd (shared
// physical pages across processes). Target RSS ~50 MB vs Metro's ~325 MB.
//
// Usage: bun src/jetplane-serve-thin.ts <projectDir> <port> <imageDir>

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
// @ts-ignore - sibling ESM helper
import { parseBundle, makeUpdate } from './jetplane-hmr.mjs'

const projectDir = process.argv[2]
let port = parseInt(process.argv[3] || '8091', 10)
const imageDir = process.argv[4] || `${process.env.JETPLANE_HOME || process.env.HOME}/.jetplane/images/expo54`

// The address a phone or another host on the network uses to reach us. `ipconfig` is
// macOS-only, so fall back to the first non-internal IPv4 interface — that's what works
// on a Linux box, where en0/en1 don't exist.
function lanIP(): string {
  for (const dev of ['en0', 'en1']) {
    try { const ip = execSync(`ipconfig getifaddr ${dev}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); if (ip) return ip } catch {}
  }
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  }
  return 'localhost'
}

// One target per native platform. Bundles are platform-specific (module ids and native
// module registrations differ), so each platform gets its own manifest + bundle + HMR maps
// and a request is answered from the target it actually asked for.
type Target = { manifestRaw: string; multipartRaw: string; boundary: string; bundle: Uint8Array; maps: any }

const NATIVE_PLATFORMS = ['ios', 'android'] as const
const targets = new Map<string, Target>()

for (const p of NATIVE_PLATFORMS) {
  const bundlePath = path.join(imageDir, `main.${p}.bundle`)
  const manifestPath = path.join(imageDir, `manifest.${p}.json`)
  if (!fs.existsSync(bundlePath) || !fs.existsSync(manifestPath)) continue
  // Expo Go (dev) requests multipart/mixed and rejects plain JSON as a "legacy manifest".
  // We replay the exact multipart response captured from Expo's own dev server.
  const multipartPath = path.join(imageDir, `manifest-multipart.${p}.bin`)
  const multipartRaw = fs.existsSync(multipartPath) ? fs.readFileSync(multipartPath, 'utf8') : ''
  targets.set(p, {
    manifestRaw: fs.readFileSync(manifestPath, 'utf8'),
    multipartRaw,
    boundary: multipartRaw ? multipartRaw.split('\r\n')[0].replace(/^--/, '') : '',
    bundle: (globalThis as any).Bun.mmap(bundlePath) as Uint8Array,
    maps: parseBundle(bundlePath),
  })
}

if (targets.size === 0) {
  console.error(`jetplane: no native bundle found in ${imageDir}. Delete it and re-run to rebuild.`)
  process.exit(1)
}

// Which target a request is for. Expo Go sends expo-platform; bundle/asset URLs carry
// ?platform=. Falling back to a *present* platform is only for odd clients that send
// neither — never a substitute for an absent one.
function platformOf(req: Request, url: URL): string {
  return (
    req.headers.get('expo-platform') ||
    url.searchParams.get('platform') ||
    (targets.has('ios') ? 'ios' : [...targets.keys()][0])
  )
}

// web target (optional): an HTML shell + a self-contained web bundle captured alongside
// the native one. The browser loads the shell, which pulls /jetplane-web.bundle and
// connects to the SAME /hot socket as the device.
const webHtmlPath = path.join(imageDir, 'index.html')
const webBundlePath = path.join(imageDir, 'main.web.bundle')
const hasWeb = fs.existsSync(webHtmlPath) && fs.existsSync(webBundlePath)
const webHtml = hasWeb ? fs.readFileSync(webHtmlPath, 'utf8') : ''
const webBundle = hasWeb ? ((globalThis as any).Bun.mmap(webBundlePath) as Uint8Array) : null

// HMR: each target's maps come from its own bundle (parsed above); web has its own too.
const webMaps = hasWeb ? parseBundle(webBundlePath) : null
const clients = new Set<any>()
const clientPlatform = new Map<any, string>() // ws -> 'ios' | 'android' | 'web'
const lan = lanIP()
let rev = 0
async function pushUpdate(absFile: string) {
  if (clients.size === 0) return
  // Group connected clients by platform — web and native have different module ids, so
  // each group gets an update built against its own bundle maps + transform options.
  const groups = new Map<string, any[]>()
  for (const ws of clients) {
    const p = clientPlatform.get(ws) || 'ios'
    ;(groups.get(p) ?? groups.set(p, []).get(p)!).push(ws)
  }
  for (const [platform, wss] of groups) {
    const m = platform === 'web' ? webMaps : targets.get(platform)?.maps
    if (!m) continue
    try {
      const { modified, added } = await makeUpdate(projectDir, absFile, m, publicOrigin(), platform)
      rev++
      const start = JSON.stringify({ type: 'update-start', body: { isInitialUpdate: false } })
      const upd = JSON.stringify({ type: 'update', body: { revisionId: String(rev), added, modified: [modified], deleted: [] } })
      const done = JSON.stringify({ type: 'update-done' })
      for (const ws of wss) { ws.send(start); ws.send(upd); ws.send(done) }
      console.log(`hmr[${platform}]: pushed ${path.relative(projectDir, absFile)} (module ${modified.module[0]}, +${added.length} new) to ${wss.length} client(s)`)
    } catch (e: any) {
      console.log(`hmr[${platform}]: skip`, path.relative(projectDir, absFile), '-', e.message)
    }
  }
}
// debounced recursive watch of the app source
const watchDirs = ['app', 'components', 'src', 'constants', 'hooks'].map((d) => path.join(projectDir, d)).filter((d) => fs.existsSync(d))
let timer: any = null
const pending = new Set<string>()
for (const dir of watchDirs) {
  fs.watch(dir, { recursive: true }, (_e, file) => {
    if (!file || !/\.(tsx?|jsx?)$/.test(file)) return
    pending.add(path.join(dir, file))
    clearTimeout(timer)
    timer = setTimeout(() => { const files = [...pending]; pending.clear(); files.forEach(pushUpdate) }, 60)
  })
}

// The origin the device/browser must use to reach us. In plain local dev this is the LAN
// host:port over http. Behind a reverse proxy (e.g. Cloudflare terminating TLS) the public
// origin differs from what we bind — so we resolve it, highest priority first:
//   1. EXPO_DEV_SERVER_ORIGIN         — a full origin, e.g. https://tunnel.example.com (wins outright)
//   2. REACT_NATIVE_PACKAGER_HOSTNAME — host[:port] (Metro's own env var); scheme from the proxy or http
//   3. X-Forwarded-Proto / X-Forwarded-Host — set by the proxy, per request
//   4. the Host header over http      — plain local dev
// EXPO_DEV_SERVER_ORIGIN is the one to set for a fixed HTTPS proxy: it also fixes the
// HMR base below (which has no request context to read forwarded headers from).
const ENV_ORIGIN = (process.env.EXPO_DEV_SERVER_ORIGIN || '').trim().replace(/\/+$/, '')
const ENV_HOST = (process.env.REACT_NATIVE_PACKAGER_HOSTNAME || '').trim()

function publicOrigin(req?: Request): string {
  if (ENV_ORIGIN) return ENV_ORIGIN
  const h = req?.headers
  const fwdProto = h?.get('x-forwarded-proto')?.split(',')[0]?.trim()
  const fwdHost = h?.get('x-forwarded-host')?.split(',')[0]?.trim()
  const host = ENV_HOST || fwdHost || h?.get('host') || `${lan}:${port}`
  if (/^https?:\/\//.test(host)) return host.replace(/\/+$/, '') // host already carries a scheme
  return `${fwdProto || 'http'}://${host}`
}

// The captured manifest bakes the *build* server's own URL (e.g. http://127.0.0.1:8099,
// the temporary capture Metro) into launchAsset + assets. Rewrite ANY localhost/127.0.0.1
// origin to the public origin above, so the bundle + asset URLs point back at this thin
// server (simulator localhost, a LAN phone, or a device reaching us through a proxy).
const rewriteHost = (s: string, origin: string) =>
  s.replace(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/g, origin)

// expo-updates stores each loaded manifest in SQLite keyed by (scope_key, commit_time).
// Our replayed manifest is static, so re-scanning collides (UNIQUE constraint). Give
// every manifest a fresh id + createdAt so each load is a distinct update.
const freshen = (s: string): string => s
  .replace(/"id":"[^"]*"/, `"id":"${randomUUID()}"`)
  .replace(/"createdAt":"[^"]*"/, `"createdAt":"${new Date().toISOString()}"`)

const rssMB = () => (process.memoryUsage().rss / 1048576).toFixed(1)

// best-effort asset resolution from the project (images referenced by the bundle)
function serveAsset(url: URL): Response {
  try {
    let rel = url.searchParams.get('unstable_path')
    if (rel) rel = decodeURIComponent(rel)
    else rel = url.pathname.replace(/^\/assets\/?/, '')
    const abs = path.resolve(projectDir, rel || '')
    if (abs.startsWith(projectDir) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      return new Response(fs.readFileSync(abs))
    }
  } catch {}
  return new Response('asset not found', { status: 404 })
}

const serveOpts = {
  hostname: '0.0.0.0', // reachable from a phone on the LAN
  fetch(req: Request, server: any) {
    const url = new URL(req.url)
    const origin = publicOrigin(req)

    if (url.pathname === '/hot') { if (server.upgrade(req)) return undefined as any }
    // Metro's runtime also opens /message (log/event forwarding). Accept and
    // ignore it — refusing the upgrade shows up as a failed WebSocket in every
    // client console.
    if (url.pathname === '/message') { if (server.upgrade(req, { data: { message: true } })) return undefined as any }
    if (url.pathname === '/status') return new Response('packager-status:running')

    // web target: the self-contained web bundle, and the HTML shell for a browser.
    if (hasWeb) {
      if (url.pathname === '/jetplane-web.bundle') {
        return new Response(webBundle, { headers: { 'content-type': 'application/javascript', 'x-jetplane-rss-mb': rssMB() } })
      }
      const wantsHtml = (req.headers.get('accept') || '').includes('text/html') && !req.headers.get('expo-platform')
      if (wantsHtml && (url.pathname === '/' || url.pathname === '/index.html')) {
        return new Response(webHtml, { headers: { 'content-type': 'text/html; charset=utf-8' } })
      }
    }

    // Everything below is platform-specific. An unknown platform is an error, not a
    // silent fallback to another platform's bundle — that boots to a broken app.
    const platform = platformOf(req, url)
    if (platform === 'web' && hasWeb && url.pathname.endsWith('.bundle')) {
      return new Response(webBundle, { headers: { 'content-type': 'application/javascript', 'x-jetplane-platform': 'web', 'x-jetplane-rss-mb': rssMB() } })
    }
    const target = targets.get(platform)
    if (!target) {
      const msg = `jetplane: no ${platform} bundle in this image (have: ${[...targets.keys()].join(', ')}). Delete ~/.jetplane/images and re-run to rebuild.`
      console.log(msg)
      return new Response(msg, { status: 404 })
    }

    if (url.pathname.endsWith('.bundle')) {
      return new Response(target.bundle, { headers: { 'content-type': 'application/javascript', 'x-jetplane-platform': platform, 'x-jetplane-rss-mb': rssMB() } })
    }

    if (url.pathname.startsWith('/assets')) return serveAsset(url)

    // manifest: rewrite the captured host to whatever the client reached us on, so the
    // bundle + asset URLs point back here (works for simulator localhost and LAN phone)
    const accept = req.headers.get('accept') || ''
    if (accept.includes('multipart/mixed') && target.multipartRaw) {
      return new Response(rewriteHost(freshen(target.multipartRaw), origin), {
        headers: {
          'content-type': `multipart/mixed; boundary=${target.boundary}`,
          'expo-protocol-version': '0',
          'expo-sfv-version': '0',
          'x-jetplane-platform': platform,
          'cache-control': 'private, max-age=0',
        },
      })
    }
    return new Response(rewriteHost(freshen(target.manifestRaw), origin), { headers: { 'content-type': 'application/expo+json', 'x-jetplane-platform': platform, 'cache-control': 'private, max-age=0' } })
  },
  websocket: {
    open(ws: any) { if (!ws.data?.message) clients.add(ws) },
    close(ws: any) { clients.delete(ws); clientPlatform.delete(ws) },
    message(ws: any, msg: any) {
      let data: any = {}
      try { data = JSON.parse(String(msg)) } catch { return }
      if (data.type === 'register-entrypoints') {
        // The entry-point URL carries the platform, so we know which bundle maps to
        // build this client's HMR updates against.
        const eps = Array.isArray(data.entryPoints) ? data.entryPoints.join(' ') : String(data.entryPoints ?? '')
        const platform = /platform=web/.test(eps) ? 'web' : /platform=android/.test(eps) ? 'android' : 'ios'
        clientPlatform.set(ws, platform)
        ws.send(JSON.stringify({ type: 'bundle-registered' }))
      }
    },
  },
}

// Bind the port, stepping to the next one if it's busy — a machine may already be
// running other jetplane servers (or the previous one hasn't exited yet).
// ...unless the user asked for a specific port (-p/--port/$PORT), in which case drifting
// would silently break whatever is pointed at it (a proxy, a tunnel, a firewall rule).
const STRICT_PORT = process.env.JETPLANE_STRICT_PORT === '1'
const MAX_PORT_TRIES = STRICT_PORT ? 1 : 20
let server: any
for (let attempt = 0; ; attempt++) {
  try {
    server = (globalThis as any).Bun.serve({ ...serveOpts, port })
    break
  } catch (e: any) {
    const busy = e?.code === 'EADDRINUSE' || /EADDRINUSE|address already in use|is in use/i.test(String(e?.message ?? e))
    if (busy && STRICT_PORT) {
      console.error(`jetplane: port ${port} is already in use. Free it, or pass a different --port.`)
      process.exit(1)
    }
    if (busy && attempt < MAX_PORT_TRIES - 1) {
      console.log(`jetplane: port ${port} is in use — trying ${port + 1}...`)
      port++
      continue
    }
    if (busy) {
      console.error(`jetplane: couldn't find a free port in ${port - attempt}..${port}. Free one up or pass --port <n>.`)
      process.exit(1)
    }
    throw e
  }
}
port = server.port

const sizes = [...targets].map(([p, t]) => `${p}=${(t.bundle.length / 1048576).toFixed(1)}MB`).join(' ')
console.log(`jetplane-serve-thin: :${port}  ${sizes} mmap'd  idleRSS=${rssMB()}MB (no Metro)`)
if (ENV_ORIGIN || ENV_HOST) {
  console.log(`jetplane: advertising public origin ${publicOrigin()}` +
    (ENV_ORIGIN ? ' (EXPO_DEV_SERVER_ORIGIN)' : ` (REACT_NATIVE_PACKAGER_HOSTNAME; scheme from X-Forwarded-Proto or http)`))
}

const ip = lanIP()
const expUrl = `exp://${ip}:${port}`
try {
  const require = createRequire(projectDir + '/')
  const qrcode = require('qrcode-terminal')
  console.log('\nScan with Expo Go:')
  qrcode.generate(expUrl, { small: true }, (qr: string) => console.log(qr))
} catch (e) {
  console.log('\n(install qrcode-terminal for a QR)')
}
console.log(`  Phone (same Wi-Fi):  ${expUrl}`)
console.log(`  Simulator:           exp://localhost:${port}`)
if (hasWeb) console.log(`  Web (browser):       http://localhost:${port}`)

// ── interactive keys, à la `expo start` ──────────────────────────────────────
const sh = (cmd: string) => { try { execSync(cmd, { stdio: 'ignore' }) } catch {} }
function openWeb() {
  if (!hasWeb) { console.log('jetplane: no web bundle was captured for this project (is react-native-web installed?).'); return }
  console.log(`jetplane: opening web → http://localhost:${port}`)
  sh(`open "http://localhost:${port}"`)
}
function openIOS() {
  console.log(`jetplane: opening iOS simulator (Expo Go) → exp://localhost:${port}`)
  sh('open -a Simulator')
  sh(`xcrun simctl openurl booted "exp://localhost:${port}"`)
}
function openAndroid() {
  console.log(`jetplane: opening Android (Expo Go) → exp://localhost:${port}`)
  sh(`adb reverse tcp:${port} tcp:${port}`)
  sh(`adb shell am start -a android.intent.action.VIEW -d "exp://localhost:${port}"`)
}
function menu() {
  const w = hasWeb ? 'w │ web' : 'w │ web (n/a)'
  console.log(`\n  ${w}    i │ iOS    a │ Android    ? │ help    q │ quit\n`)
}
menu()

const stdin: any = process.stdin
if (stdin.isTTY) {
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding('utf8')
  stdin.on('data', (key: string) => {
    switch (key) {
      case 'w': openWeb(); break
      case 'i': openIOS(); break
      case 'a': openAndroid(); break
      case '?':
      case 'h': menu(); break
      case 'q':
      case '\u0003': console.log('\njetplane: bye'); process.exit(0)
    }
  })
}

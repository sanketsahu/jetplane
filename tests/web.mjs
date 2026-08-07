// Playwright layer of the release gate: what an actual BROWSER sees.
//
//   node tests/web.mjs
//
// Replays the full RapidNative production shape end-to-end, on the host machine:
//   1. bake a scaffold-only image (the fixture minus its "AI-generated" screens)
//   2. restore the screens and boot serve-thin from the STALE image, orchd-style
//   3. browser: the added home screen must RENDER, with zero console errors
//   4. web HMR: editing the screen hot-swaps visible text without a reload
// This is the assertion that catches "blank screen on device" — bundle contents
// alone can look right while the app renders nothing.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = path.join(REPO, 'tests', 'fixtures', 'router-app')
const PORT = 8133
const SCREEN = path.join(DIR, 'app', '(app)', 'index.tsx')
const DRIFT_FILES = ['app/(app)/index.tsx', 'app/(auth)/login.tsx']

const results = []
const record = (name, pass, detail = '') => {
  results.push({ name, pass })
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, step = 500) {
  const dl = Date.now() + ms
  while (Date.now() < dl) { if (await fn().catch(() => false)) return true; await sleep(step) }
  return false
}

// jetplane must resolve from the project root during capture
const link = path.join(DIR, 'node_modules', 'jetplane')
const hadLink = fs.existsSync(link)
if (!hadLink) fs.symlinkSync(REPO, link)

const saved = new Map()
for (const rel of DRIFT_FILES) {
  const abs = path.join(DIR, rel)
  saved.set(abs, fs.readFileSync(abs, 'utf8'))
  fs.rmSync(abs)
}
const restore = () => { for (const [abs, src] of saved) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, src) } }

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-web-'))
const log = path.join(home, 'serve.log')
let srv = null
const kill = () => { if (srv) try { process.kill(-srv.pid) } catch {} ; srv = null }
process.on('exit', () => { kill(); restore(); if (!hadLink) fs.rmSync(link, { force: true }) })

let browser = null
try {
  // 1. bake scaffold-only
  console.log('baking scaffold-only image (one cold Metro build)...')
  let out = fs.openSync(log, 'w')
  srv = spawn('node', [path.join(REPO, 'bin', 'jetplane.mjs'), 'serve', '--port', String(PORT)], {
    cwd: DIR, env: { ...process.env, JETPLANE_HOME: home }, stdio: ['ignore', out, out], detached: true,
  })
  const baked = await until(async () => (await fetch(`http://localhost:${PORT}/status`)).ok, 8 * 60_000, 2000)
  kill()
  record('bake: scaffold-only image built', baked)
  if (!baked) { console.log(fs.readFileSync(log, 'utf8').split('\n').slice(-12).join('\n')); process.exit(1) }
  const imgRoot = path.join(home, '.jetplane', 'images')
  const imageDir = path.join(imgRoot, fs.readdirSync(imgRoot)[0])
  await until(async () => !(await fetch(`http://localhost:${PORT}/status`).then(() => true).catch(() => false)), 15_000, 500)

  // 2. restore the "AI-generated" screens, boot from the stale image
  restore()
  out = fs.openSync(log, 'a')
  srv = spawn('bun', [path.join(REPO, 'src', 'jetplane-serve-thin.ts'), DIR, String(PORT), imageDir], {
    cwd: DIR, env: { ...process.env, JETPLANE_HOME: home }, stdio: ['ignore', out, out], detached: true,
  })
  const up = await until(async () => (await fetch(`http://localhost:${PORT}/status`)).ok, 60_000, 1000)
  record('boot: thin-serve up from stale image', up)
  if (!up) { console.log(fs.readFileSync(log, 'utf8').split('\n').slice(-12).join('\n')); process.exit(1) }

  // 3. browser render
  browser = await chromium.launch()
  const page = await browser.newPage()
  const consoleErrors = []
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
  let navs = 0
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs++ })

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' })
  const rendered = await page.getByTestId('home-title').isVisible({ timeout: 60_000 }).catch(() => false) ||
    await until(async () => (await page.getByTestId('home-title').count()) > 0, 60_000, 1000)
  record('web: post-bake home screen renders', !!rendered, rendered ? '' : `body: ${JSON.stringify((await page.textContent('body').catch(() => ''))?.slice(0, 120))}`)
  record('web: zero console errors on load', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

  // 4. web HMR: text hot-swap without reload
  const navsBefore = navs
  const orig = saved.get(SCREEN)
  const token = `Hot swapped ${Date.now()}`
  fs.writeFileSync(SCREEN, orig.replace('Welcome home', token))
  const swapped = await until(async () => (await page.textContent('body').catch(() => '') || '').includes(token), 30_000, 1000)
  fs.writeFileSync(SCREEN, orig)
  record('web: hmr swaps visible text', swapped)
  record('web: hmr without full reload', navs === navsBefore, navs > navsBefore ? `page navigated ${navs - navsBefore}x` : '')
  const hmrErrors = consoleErrors.length
  record('web: zero console errors after hmr', hmrErrors === 0, consoleErrors.slice(0, 3).join(' | '))
} finally {
  try { await browser?.close() } catch {}
  kill()
  restore()
}

const fails = results.filter((r) => !r.pass)
console.log(`\n${results.length - fails.length} pass, ${fails.length} fail`)
process.exit(fails.length ? 1 : 0)

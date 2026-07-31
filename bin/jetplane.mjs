#!/usr/bin/env node
// jetplane CLI (Node). The shippable, no-Bun surface: wire the cross-project transform
// cache into an Expo project's Metro. The thin-serve + HMR modes are experimental and
// run under Bun (see the repo docs).
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const [cmd] = process.argv.slice(2)

const HELP = `jetplane ${pkg.version}

Cross-project transform cache + thin no-Metro dev server for Expo/React Native.

Install it as a project dev dependency (Metro resolves 'jetplane/transformer' from
there), then run the CLI with npx:

  npm install -D jetplane

Usage:
  jetplane dev         Fresh project: wire the plugin + install deps + build + serve (unified)
  jetplane init        Just wire the transform cache into metro.config.js (then use expo start)
  jetplane serve       Thin server only, for an already-set-up project
  jetplane --help      Show this help
  jetplane --version   Print the version

Options (dev / serve):
  -p, --port <n>       Port to serve on (default 8091, or $PORT). An explicit port is
                       strict: if it's taken, jetplane exits rather than picking another.

Two ways to use it:
  • Plugin only (recommended, plain Node): 'jetplane init', then your normal
    'npx expo start' — every same-dep project shares one transform cache, so cold
    bundles stop re-transforming node_modules.
  • Thin server (experimental, needs Bun): 'jetplane dev' does the whole fresh-project
    setup and serves the bundle from a ~40 MB no-Metro process with live HMR (prints a
    QR for Expo Go). 'jetplane serve' just serves an already-set-up project.
    ('jetplane start' is an alias of 'jetplane dev'.)

Docs: ${pkg.homepage}`

const CONFIG = `const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// jetplane: cross-project transform cache. Same module transforms once and is reused
// across every same-dep project (which Metro's own root-dependent cache cannot do).
// Wrap whatever transformer is already configured (Expo's default here, or NativeWind's
// when withNativeWind runs) so their behavior is preserved — jetplane only caches around it.
config.transformer.upstreamTransformerPath = config.transformerPath;
config.transformerPath = require.resolve('jetplane/transformer');
config.cacheStores = []; // jetplane owns caching

module.exports = config;
`

function init() {
  const target = path.join(process.cwd(), 'metro.config.js')
  if (existsSync(target)) {
    console.error(`metro.config.js already exists. Add these lines just before your module.exports (use the final config object — e.g. the return of withNativeWind):\n
  config.transformer.upstreamTransformerPath = config.transformerPath;
  config.transformerPath = require.resolve('jetplane/transformer');
  config.cacheStores = [];\n`)
    process.exit(1)
  }
  writeFileSync(target, CONFIG)
  console.log(`wrote metro.config.js — run 'npx expo start' to use the shared cache.`)
}

// Port selection, matching `expo start`'s surface: -p/--port, either space- or
// =-separated, plus $PORT as the fallback (what most Linux hosts/PaaS set). An explicitly
// requested port is honored strictly — the server fails loudly instead of silently
// drifting to the next free one, which would hand a reverse proxy the wrong upstream.
const DEFAULT_PORT = 8091

function parsePort() {
  const argv = process.argv.slice(2)
  let raw = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const m = /^(?:-p|--port)(?:=(.*))?$/.exec(a)
    if (!m) continue
    raw = m[1] !== undefined ? m[1] : argv[++i]
    break
  }
  const explicit = raw != null || process.env.PORT != null
  if (raw == null) raw = process.env.PORT ?? String(DEFAULT_PORT)
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`jetplane: invalid port ${JSON.stringify(raw)} — expected an integer 1-65535.`)
    process.exit(1)
  }
  return { port, explicit }
}

// A setup failure (Metro won't boot, no free port) is a user-facing problem, not a crash —
// print the message we built and exit, without a node stack trace on top of it.
async function run(fn) {
  try { await fn() } catch (e) {
    console.error(`\njetplane: ${e?.message ?? e}`)
    process.exit(1)
  }
}

if (cmd === '--version' || cmd === '-v') console.log(pkg.version)
else if (cmd === 'init') init()
else if (cmd === 'serve') {
  const { serve } = await import('../src/jetplane-start.mjs')
  await run(() => serve({ dir: process.cwd(), ...parsePort() }))
} else if (cmd === 'dev' || cmd === 'start') {
  const { start } = await import('../src/jetplane-start.mjs')
  await run(() => start({ dir: process.cwd(), ...parsePort() }))
} else console.log(HELP)

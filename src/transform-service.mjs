#!/usr/bin/env node
// Shared transform service (Node). Loads babel-preset-expo ONCE and serves transforms
// to N thin per-project servers, so babel's ~200 MB resident cost is amortized instead
// of paid per project. Backed by the content-addressed store (path-normalized, keyed by
// source bytes -> cross-project hits).
//
// Run under Node (not Bun) to avoid the worklets-plugin @babel/generator resolution bug.
//
// Usage: node src/transform-service.mjs <toolchainProjectDir> <port>

import http from 'node:http'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const TOOLCHAIN_PROJECT = process.argv[2] || process.cwd()
const PORT = parseInt(process.argv[3] || '8199', 10)

const require = createRequire(TOOLCHAIN_PROJECT + '/')
const babel = require('@babel/core')
const PRESET = require.resolve('babel-preset-expo')
const TOOLCHAIN = `babel@${babel.version};preset-expo;v1`
const PLACEHOLDER = '\0TRAM_ROOT\0'

const STORE = path.join(process.env.JETPLANE_HOME || os.homedir(), '.jetplane', 'store')
fs.mkdirSync(STORE, { recursive: true })

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const keyOf = (src, platform) => sha(`${TOOLCHAIN}\0${platform}\0${src}`)
const rssMB = () => (process.memoryUsage().rss / 1048576).toFixed(1)

let transforms = 0, hits = 0

function storePath(key) { return path.join(STORE, key.slice(0, 2), key + '.js') }

function getOrTransform(source, filename, platform) {
  const key = keyOf(source, platform)
  const dst = storePath(key)
  if (fs.existsSync(dst)) { hits++; return { normalized: fs.readFileSync(dst, 'utf8'), cached: true } }
  const res = babel.transformSync(source, {
    filename, root: '/', cwd: TOOLCHAIN_PROJECT, babelrc: false, configFile: false,
    presets: [[PRESET, { native: {} }]],
    caller: { name: 'metro', platform, isDev: true },
  })
  // normalize: strip the project root so the entry is root-independent (cross-project)
  const root = filename.slice(0, filename.indexOf('/node_modules/') > -1 ? filename.indexOf('/node_modules/') : filename.length)
  const normalized = res.code.split(root).join(PLACEHOLDER)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.writeFileSync(dst, normalized)
  transforms++
  return { normalized, cached: false }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, rssMB: +rssMB(), transforms, hits }))
    return
  }
  if (req.method === 'POST' && req.url === '/transform') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      try {
        const { file, root, platform = 'ios', raw = false } = JSON.parse(body)
        const source = fs.readFileSync(file, 'utf8')
        const { normalized, cached } = getOrTransform(source, file, platform)
        // raw: return the normalized (placeholder) form for building a shareable vendor
        // image; otherwise rehydrate to the caller's root.
        const code = raw ? normalized : normalized.split(PLACEHOLDER).join(root)
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ code, cached }))
      } catch (e) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: String(e.message || e) }))
      }
    })
    return
  }
  res.statusCode = 404
  res.end()
})

server.listen(PORT, () => console.log(`transform-service: :${PORT}  startupRSS=${rssMB()}MB (babel core loaded; presets lazy)`))

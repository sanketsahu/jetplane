// Capture the HMR update a server pushes for a theme.ts edit, from EITHER stock
// Metro (expo start) or jetplane thin-serve, and dump it as JSON for diffing.
//
//   node tests/hmr-message-diff.mjs <port> <outfile>
//
// Connects to ws://localhost:<port>/hot, registers ios entrypoints, edits
// tests/fixtures/router-app/theme.ts, saves the first update containing theme.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIR = path.join(REPO, 'tests', 'fixtures', 'router-app')
const port = process.argv[2]
const out = process.argv[3]
const themePath = path.join(DIR, 'theme.ts')
const orig = fs.readFileSync(themePath, 'utf8')
process.on('exit', () => fs.writeFileSync(themePath, orig))

const ws = new WebSocket(`ws://localhost:${port}/hot`)
const deadline = setTimeout(() => { console.error('TIMEOUT'); process.exit(1) }, 60_000)
const seen = []
ws.onopen = () => ws.send(JSON.stringify({ type: 'register-entrypoints', entryPoints: [`http://localhost:${port}/node_modules/expo-router/entry.bundle?platform=ios&dev=true&hot=false&lazy=false&transform.engine=hermes&transform.routerRoot=app&unstable_transformProfile=hermes-stable`] }))
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data))
  seen.push(msg.type)
  if (msg.type === 'bundle-registered') {
    setTimeout(() => fs.writeFileSync(themePath, orig.replace('"--primary": "24 24 27"', '"--primary": "220 38 38"')), 500)
  }
  if (msg.type === 'update' && msg.body?.modified?.length) {
    const hasTheme = [...msg.body.modified, ...(msg.body.added || [])].some((e) => (e.sourceURL || '').includes('theme'))
    if (!hasTheme) return
    clearTimeout(deadline)
    fs.writeFileSync(out, JSON.stringify(msg.body, null, 2))
    const summary = {
      modified: msg.body.modified.map((e) => ({ id: e.module[0], sourceURL: e.sourceURL, codeLen: e.module[1].length })),
      added: (msg.body.added || []).map((e) => ({ id: e.module[0], sourceURL: e.sourceURL })),
      deleted: msg.body.deleted,
      revisionId: msg.body.revisionId,
      isInitialUpdate: msg.body.isInitialUpdate,
    }
    console.log(JSON.stringify(summary, null, 1))
    ws.close(); process.exit(0)
  }
}
ws.onerror = (e) => { console.error('ws error', e?.message); process.exit(1) }

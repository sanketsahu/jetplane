// End-to-end HMR test against a running thin server (no device needed):
// connects a fake ios client to /hot, registers entrypoints, edits a screen
// file, and asserts a hot update arrives with the modified module.
//
//   node bench/hmr-client-test.mjs <projectDir> <port> <screenRelPath>
//
// Exits 0 on a received update, 1 on timeout/skip. Uses Node's built-in
// WebSocket (Node >= 21) — no dependencies.
import fs from 'node:fs'
import path from 'node:path'

const dir = process.argv[2]
const port = process.argv[3] || '8095'
const rel = process.argv[4] || 'app/(tabs)/index.tsx'
const abs = path.join(dir, rel)
if (!fs.existsSync(abs)) { console.error(`no such screen file: ${abs}`); process.exit(2) }

const ws = new WebSocket(`ws://localhost:${port}/hot`)
const deadline = setTimeout(() => { console.error('TIMEOUT: no hot update within 30s'); process.exit(1) }, 30000)

ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'register-entrypoints', entryPoints: ['/node_modules/expo-router/entry.bundle?platform=ios&dev=true'] }))
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data))
  if (msg.type === 'bundle-registered') {
    console.log('client registered (ios) — touching', rel)
    const src = fs.readFileSync(abs, 'utf8')
    fs.writeFileSync(abs, src + `\n// hmr-test ${Date.now()}\n`)
    process.on('exit', () => fs.writeFileSync(abs, src)) // restore the bench app
    return
  }
  if (msg.type === 'update' && msg.body?.modified?.length) {
    console.log(`HOT UPDATE RECEIVED: module ${msg.body.modified[0].module?.[0] ?? '?'} (${rel})`)
    clearTimeout(deadline)
    ws.close()
    process.exit(0)
  }
}
ws.onerror = () => { console.error('ws error'); process.exit(1) }

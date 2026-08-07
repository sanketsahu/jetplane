// HMR update generation for the thin server.
//
// The pre-built bundle carries `__d(factory, id, [deps], "path")` for every module, so we
// can recover path->id, id->deps, and (by inversion) id->inverseDeps WITHOUT running
// Metro. On an app-file edit we transform just that file (hot), wrap it as a Metro HMR
// module (id + deps + verboseName + inverseDependenciesById), and push it over /hot.

import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Parse the bundle's __d defs -> maps. Format: },ID,[d,d,d],"path"
export function parseBundle(bundlePath) {
  return parseBundleSource(fs.readFileSync(bundlePath, 'utf8'))
}

// Same, from an in-memory bundle string (used after patching a served bundle: a later
// __d for an id wins, and pathToId.set overwrites likewise, so re-parsing a patched
// bundle yields the post-patch graph).
export function parseBundleSource(src) {
  const pathToId = new Map()
  const idToDeps = new Map()
  const idToInverse = new Map()
  const re = /\},(\d+),\[([\d,]*)\],"((?:[^"\\]|\\.)*)"/g
  let m
  while ((m = re.exec(src))) {
    const id = +m[1]
    const deps = m[2] ? m[2].split(',').map(Number) : []
    const p = m[3]
    pathToId.set(p, id)
    idToDeps.set(id, deps)
  }
  // invert
  for (const [id, deps] of idToDeps) for (const d of deps) {
    if (!idToInverse.has(d)) idToInverse.set(d, [])
    idToInverse.get(d).push(id)
  }
  return { pathToId, idToDeps, idToInverse, src }
}

// The transformed module references deps as require(_dependencyMap[N], "NAME"). To build
// a correct dependencyMap array we must map each NAME (in _dependencyMap order) to a
// module id. Existing deps resolve via the requesting module's own original name->id
// (recovered from the bundle); newly-added deps (e.g. babel helpers) resolve as bare
// package paths.
function reqNamesInOrder(code) {
  const arr = []
  for (const m of code.matchAll(/_dependencyMap\[(\d+)\],\s*"((?:[^"\\]|\\.)*)"/g)) arr[+m[1]] = m[2]
  return arr
}
function moduleRegion(src, id) {
  const marker = `,${id},[`
  const at = src.indexOf(marker)
  if (at < 0) return ''
  return src.slice(src.lastIndexOf('__d(', at), at)
}
// Build the dependencyMap id-array for a module's HOT-transformed code. Names present in
// the bundle resolve to their bundle id (via the requester's own name->id recovered from
// the bundle); names NOT in the bundle (new deps) are resolved on disk, and if still not
// in the bundle get a fresh id and are pushed to `newMods` to be sent as `added`.
// Node's require.resolve can't see TypeScript sources, directory index.ts files, or
// the project's "@/" root alias — all normal in an Expo app. Approximate Metro's
// resolution: Node first, then extension/index probing (platform-specific first).
function resolveSourceFile(req, requesterFile, name, projectDir, platform) {
  try { return req.resolve(name) } catch {}
  const bases = []
  if (name.startsWith('.')) bases.push(path.resolve(path.dirname(requesterFile), name))
  else if (name.startsWith('@/')) bases.push(path.resolve(projectDir, name.slice(2)))
  else if (name.startsWith('/')) bases.push(name)
  const exts = [
    ...(platform ? [`.${platform}.tsx`, `.${platform}.ts`, `.${platform}.jsx`, `.${platform}.js`] : []),
    '.tsx', '.ts', '.jsx', '.js',
  ]
  for (const base of bases) {
    try { if (fs.statSync(base).isFile()) return base } catch {}
    for (const e of exts) { const p = base + e; if (fs.existsSync(p)) return p }
    for (const e of exts) { const p = path.join(base, 'index' + e); if (fs.existsSync(p)) return p }
  }
  return null
}

// Bundle-wide bare-specifier -> module id index (lazy, cached on maps). When a
// post-bake file imports "react-native-safe-area-context" and some baked module
// already did too, the baked id must be reused — re-resolving through Node picks a
// different build (lib/commonjs vs lib/module) and ships a DUPLICATE package whose
// React contexts don't match the baked providers. Relative names are excluded:
// "./utils" means something different in every module.
function globalNameToId(maps) {
  if (maps._nameToId) return maps._nameToId
  const tails = []
  const tre = /\},(\d+),\[([\d,]*)\],"(?:[^"\\]|\\.)*"/g
  let t
  while ((t = tre.exec(maps.src))) tails.push({ pos: t.index, deps: t[2] ? t[2].split(',').map(Number) : [] })
  const m = new Map()
  const re = /_dependencyMap\[(\d+)\],\s*"((?:[^"\\]|\\.)*)"/g
  let ti = 0, mm
  while ((mm = re.exec(maps.src))) {
    if (mm[2].startsWith('.')) continue
    while (ti < tails.length && tails[ti].pos < mm.index) ti++
    if (ti >= tails.length) break
    const id = tails[ti].deps[+mm[1]]
    if (id != null && !m.has(mm[2])) m.set(mm[2], id)
  }
  maps._nameToId = m
  return m
}

function resolveDeps(maps, requesterFile, requesterId, hotCode, projectDir, newMods, platform) {
  const req = createRequire(requesterFile)
  const nameToId = new Map()
  if (maps.idToDeps.has(requesterId)) {
    const rn = reqNamesInOrder(moduleRegion(maps.src, requesterId))
    const rd = maps.idToDeps.get(requesterId)
    rn.forEach((n, i) => { if (n != null && rd[i] != null) nameToId.set(n, rd[i]) })
  }
  const hotNames = reqNamesInOrder(hotCode)
  return hotNames.map((name) => {
    if (name == null) return 0
    if (nameToId.has(name)) return nameToId.get(name)
    if (!name.startsWith('.')) {
      const gid = globalNameToId(maps).get(name)
      if (gid != null) return gid
    }
    const file = resolveSourceFile(req, requesterFile, name, projectDir, platform)
    if (!file) throw new Error(`cannot resolve "${name}" from ${requesterFile}`)
    const rel = path.relative(projectDir, file).split(path.sep).join('/')
    if (maps.pathToId.has(rel)) return maps.pathToId.get(rel)
    const nid = freshId(rel)
    if (!newMods.some((m) => m.id === nid)) newMods.push({ id: nid, file, rel })
    return nid
  })
}

// inverse-dependency closure above `startId`, as { id: [directInverseIds] }
function inverseClosure(startId, idToInverse) {
  const out = Object.create(null)
  const seen = new Set([startId])
  const q = [startId]
  while (q.length) {
    const n = q.shift()
    const inv = idToInverse.get(n) || []
    out[n] = inv
    for (const i of inv) if (!seen.has(i)) { seen.add(i); q.push(i) }
  }
  return out
}

// stable fresh ids for modules NOT in the pre-built bundle (e.g. babel helpers pulled in
// by the React Refresh transform). Persist across edits so re-edits reuse the same id.
const NEW_IDS = new Map()
let NEXT_ID = 9_000_000
function freshId(rel) { if (!NEW_IDS.has(rel)) NEW_IDS.set(rel, NEXT_ID++); return NEW_IDS.get(rel) }

// The transform/emit machinery shared by single-file updates (makeUpdate) and
// multi-file drift reconciliation (makeDriftUpdate).
function createProcessor(projectDir, maps, clientUrlBase, platform) {
  const req = createRequire(projectDir + '/')
  const worker = req('metro-transform-worker')
  const { addParamsToDefineCall } = req('metro-transform-plugins')
  const { getDefaultConfig } = req('expo/metro-config')
  const transformerConfig = getDefaultConfig(projectDir).transformer

  // MUST match the options the target's bundle was built with (reactCompiler, routerRoot,
  // engine) or the _dependencyMap indices won't line up with the bundle ids. Native uses
  // the Hermes profile/engine; web uses neither (it targets the browser JS engine).
  const isWeb = platform === 'web'
  const options = {
    dev: true, hot: true, inlinePlatform: true, minify: false, platform,
    type: 'module',
    ...(isWeb ? {} : { unstable_transformProfile: 'hermes-stable' }),
    customTransformOptions: isWeb
      ? { __proto__: null, routerRoot: 'app', reactCompiler: 'true' }
      : { __proto__: null, engine: 'hermes', routerRoot: 'app', reactCompiler: 'true' },
    experimentalImportSupport: false, publicPath: '/assets',
  }
  const transform = (file) => worker.transform(transformerConfig, projectDir, file, fs.readFileSync(file), options)
  const urlFor = (rel) => `${clientUrlBase}/${rel.replace(/\.(t|j)sx?$/, '')}.bundle`

  // temp inverse graph so closures include the new module edges we add below
  const inv = new Map(maps.idToInverse)
  const addEdge = (childId, parentId) => inv.set(childId, [...(inv.get(childId) || []), parentId])

  const added = []
  const visited = new Set()
  // transform a module, resolve its deps (collecting new ones), recurse, emit entry
  const process = async (file, id, rel, isNew, parentId) => {
    if (visited.has(id)) return
    visited.add(id)
    if (isNew && parentId != null) addEdge(id, parentId)
    const r = await transform(file)
    const factory = r.output[0].data.code
    const newMods = []
    const deps = resolveDeps(maps, file, id, factory, projectDir, newMods, platform)
    for (const nm of newMods) await process(nm.file, nm.id, nm.rel, true, id)
    let code = addParamsToDefineCall(factory, id, deps, rel, inverseClosure(id, inv))
    code += `\n//# sourceURL=${urlFor(rel)}\n`
    const entry = { module: [id, code], sourceURL: urlFor(rel) }
    if (isNew) added.push(entry)
    return entry
  }
  return { process, added, addEdge, inv, addParamsToDefineCall, urlFor }
}

// Build the HMR update for a changed file: { modified: [entries], added: [entries] }.
// `added` carries modules the hot transform pulled in that are NOT in the pre-built
// bundle (babel/React-Refresh helpers — or the file itself, when it was created after
// the bundle was baked; that case routes through makeDriftUpdate so the expo-router
// context learns the new route too).
export async function makeUpdate(projectDir, absFile, maps, clientUrlBase, platform = 'ios') {
  const rel = path.relative(projectDir, absFile).split(path.sep).join('/')
  const id = maps.pathToId.get(rel)
  if (id == null) {
    const drift = await makeDriftUpdate(projectDir, maps, clientUrlBase, platform)
    if (!drift) throw new Error(`no module id for ${rel} (not in bundle, and no reconcilable drift)`)
    return drift
  }
  const P = createProcessor(projectDir, maps, clientUrlBase, platform)
  const modified = await P.process(absFile, id, rel, false, null)
  return { modified: [modified], added: P.added }
}

// All source files under the router root, as project-relative paths — what the
// app's require.context should currently see on disk.
function listAppFiles(projectDir, routerRoot = 'app') {
  const out = []
  const walk = (d) => {
    let ents
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name.startsWith('.')) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.[tj]sx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(path.relative(projectDir, p).split(path.sep).join('/'))
    }
  }
  walk(path.join(projectDir, routerRoot))
  return out
}

// Regenerate the expo-router require.context module ("app?ctx=<hash>") against the
// files currently on disk. Mirrors metro's generated context-module shape exactly.
function regenCtx(P, projectDir, maps, ctxRel, ctxId, appFiles, routerRoot = 'app') {
  const entries = appFiles.map((rel) => ({
    key: './' + rel.slice(routerRoot.length + 1),
    id: maps.pathToId.get(rel) ?? NEW_IDS.get(rel),
    name: path.join(projectDir, rel),
  })).filter((e) => e.id != null)
  const props = entries.map((e, i) =>
    `    ${JSON.stringify(e.key)}: {\n      enumerable: true,\n      get() {\n        return require(_dependencyMap[${i}], ${JSON.stringify(e.name)});\n      }\n    }`
  ).join(',\n')
  const factory = `function (global, require, _$$_IMPORT_DEFAULT, _$$_IMPORT_ALL, module, exports, _dependencyMap) {
  // All of the requested modules are loaded behind enumerable getters.
  var map = Object.defineProperties({}, {
${props}
  });
  function metroContext(request) {
    return map[request];
  }

  // Return the keys that can be resolved.
  metroContext.keys = function metroContextKeys() {
    return Object.keys(map);
  };

  // Return the module identifier for a user request.
  metroContext.resolve = function metroContextResolve(request) {
    throw new Error('Unimplemented Metro module context functionality');
  };
  module.exports = metroContext;
}`
  const deps = entries.map((e) => e.id)
  // addParamsToDefineCall splices params before the LAST ")" — it expects the
  // already-wrapped `__d(fn)` expression (what the transform worker emits), not a
  // bare function. A bare function here is a SyntaxError in the patched bundle.
  let code = P.addParamsToDefineCall(`__d(${factory})`, ctxId, deps, ctxRel, inverseClosure(ctxId, P.inv))
  code += `\n//# sourceURL=${P.urlFor(ctxRel.replace(/\?.*$/, '/__ctx__.js'))}\n`
  return { module: [ctxId, code], sourceURL: P.urlFor(ctxRel.replace(/\?.*$/, '/__ctx__.js')) }
}

// Reconcile everything that changed since the bundle was baked, in one update:
//   - route files ADDED after bake  -> transformed with fresh ids + ctx regenerated
//   - route files DELETED after bake -> dropped from the regenerated ctx
//   - files CHANGED after bake       -> re-transformed in place (needs `manifest`, the
//     rel->sha256 map written by the capture step as files.json)
// This is THE RapidNative/orchd production shape: docker images are baked from the
// template scaffold, and every real project adds its own (AI-generated) route files
// on top. Returns { modified, added } or null when there is nothing to reconcile.
export async function makeDriftUpdate(projectDir, maps, clientUrlBase, platform = 'ios', manifest = null, routerRoot = 'app') {
  const P = createProcessor(projectDir, maps, clientUrlBase, platform)
  const modified = []

  const ctxRel = [...maps.pathToId.keys()].find((k) => k.startsWith(`${routerRoot}?ctx=`))
  const appFiles = listAppFiles(projectDir, routerRoot)
  const addedFiles = appFiles.filter((r) => !maps.pathToId.has(r))
  const removedFiles = [...maps.pathToId.keys()].filter(
    (k) => k.startsWith(`${routerRoot}/`) && /\.[tj]sx?$/.test(k) && !fs.existsSync(path.join(projectDir, k))
  )
  if (ctxRel && (addedFiles.length || removedFiles.length)) {
    const ctxId = maps.pathToId.get(ctxRel)
    for (const rel of addedFiles) P.addEdge(freshId(rel), ctxId)
    for (const rel of addedFiles) await P.process(path.join(projectDir, rel), freshId(rel), rel, true, ctxId)
    modified.push(regenCtx(P, projectDir, maps, ctxRel, ctxId, appFiles, routerRoot))
  }

  if (manifest) {
    const { createHash } = await import('node:crypto')
    for (const [rel, sha] of Object.entries(manifest)) {
      const abs = path.join(projectDir, rel)
      const id = maps.pathToId.get(rel)
      if (id == null || !fs.existsSync(abs)) continue
      const now = createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
      if (now !== sha) modified.push(await P.process(abs, id, rel, false, null))
    }
  }

  if (!modified.length && !P.added.length) return null
  return { modified, added: P.added }
}

// self-test: parse the captured bundle, make an update for (tabs)/index.tsx
if (process.argv[1] && process.argv[1].endsWith('jetplane-hmr.mjs')) {
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const PROJECT = process.env.TRAM_PROJECT || path.join(REPO, 'bench', 'expo-app-54')
  const BUNDLE = `${process.env.HOME}/.jetplane/images/expo54/main.ios.bundle`
  const maps = parseBundle(BUNDLE)
  console.log('parsed modules:', maps.pathToId.size)
  const rel = 'app/(tabs)/index.tsx'
  console.log(`${rel} -> id`, maps.pathToId.get(rel), '| deps', (maps.idToDeps.get(maps.pathToId.get(rel)) || []).length, '| inverse', (maps.idToInverse.get(maps.pathToId.get(rel)) || []).length)
  const u = await makeUpdate(PROJECT, `${PROJECT}/${rel}`, maps, 'http://localhost:8091')
  const mod = u.modified[0]
  console.log('modified module id:', mod.module[0])
  console.log('modified starts with __d:', mod.module[1].startsWith('__d('))
  console.log('has RefreshReg (React Refresh):', mod.module[1].includes('RefreshReg') || mod.module[1].includes('$RefreshSig'))
  console.log('added modules:', u.added.map((a) => a.module[0]).join(', ') || '(none)')
  for (const a of u.added) {
    const relOfId = [...maps.pathToId.entries()].find(([, v]) => v === a.module[0])
    console.log('  added id', a.module[0], '-> fresh module (new dep), code starts __d:', a.module[1].startsWith('__d('))
  }
  console.log('modified dep tail:', JSON.stringify(mod.module[1].slice(-140)))
}

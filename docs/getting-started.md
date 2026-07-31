# Getting started

## Install (the Metro plugin) — in your Expo project

Requires Expo SDK 54+ and Node 20+.

Install jetplane as a dev dependency — Metro resolves `jetplane/transformer` from the
project, so a local install is required (a global `-g` install is optional sugar for the
CLI, not a substitute). Run the CLI with `npx` or an npm script.

> `npx jetplane <cmd>` runs the CLI out of npx's cache, which does **not** make it
> resolvable from your project. `jetplane init` and `serve` refuse to run without the local
> install rather than write a `metro.config.js` that Metro can't load; `jetplane dev`
> installs it for you.

```bash
npm install -D jetplane
npx jetplane init       # wires the transform cache into metro.config.js
npx expo start          # your normal flow — now cross-project cached
```

## The CLI at a glance

```bash
npx jetplane init       # just wire the cache into metro.config.js (plain Node)
npx jetplane serve      # thin no-Metro server for an already-set-up project (needs Bun)
npx jetplane dev        # unified: init + install + build + serve — for a fresh project
                        #   ('jetplane start' is an alias of 'dev')
npx jetplane            # no argument → prints help
```

`jetplane init` creates `metro.config.js` if you don't have one, or wires the plugin into
the one you do have:

```js
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)
// wrap whatever transformer is already configured, so its behavior is preserved —
// jetplane only adds a cross-project cache around it
config.transformer.upstreamTransformerPath = config.transformerPath
config.transformerPath = require.resolve('jetplane/transformer') // the Metro plugin
config.cacheStores = []                                          // jetplane owns caching

module.exports = config
```

If your config exports a call rather than a bare object — `module.exports =
withNativeWind(config, ...)` — the wiring binds that result first, so NativeWind's (or any
other wrapper's) transformer becomes the upstream instead of being replaced.

The first bundle populates a shared, content-addressed cache under `~/.jetplane`. Every
other same-dep project (and every restart) reuses it, so cold bundles stop re-transforming
`node_modules`. That is the whole integration — you keep the entire Expo CLI and `expo start`.

## Reproduce the benchmarks from this repo

`bench/expo-app-54*` are Expo SDK 54 apps (expo-router + Reanimated) with the plugin wired
in. Prerequisites: Node ≥ 20, Bun ≥ 1.2 (for the thin server), and Expo Go / a simulator.

```bash
cd bench/expo-app-54
npx expo start          # first run builds the shared cache in ~/.jetplane/tstore
```

Bundle a **different** project with the same deps — it reuses the cache cross-project:

```bash
cd ../bench/expo-app-54-b
npx expo start --port 8082
node ../../src/jetplane-stats.mjs   # hit-rate for the last bundle (reset with: … reset)
```

## Thin, no-Metro dev server + HMR (experimental)

One command (needs [Bun](https://bun.sh)):

```bash
npx jetplane dev        # 'jetplane start' is an alias
```

`jetplane dev` (1) ensures the plugin is wired into `metro.config.js`, (2) installs deps
if needed, (3) builds a device-bootable bundle once (runs Metro a single time), then (4)
serves it from the thin, no-Metro process (~40 MB) and prints a QR.

Scan the QR in Expo Go (or `exp://localhost:8091` on the simulator). Edit
`app/(tabs)/index.tsx` and save — the screen hot-reloads via React Refresh, served
entirely from the thin process. The bundle is cached per lockfile under `~/.jetplane`;
delete it to force a rebuild.

### Native and web from one server

The build also captures a self-contained **web** bundle, and the thin server serves both
targets at once: Expo Go loads the device manifest, and a browser at
`http://localhost:<port>` gets the web HTML shell + bundle. HMR works for both — each
connected client is tagged by platform and gets an update built against its own bundle.

The dev server takes interactive keys, like `expo start`:

```
w │ web      i │ iOS simulator      a │ Android      ? │ help      q │ quit
```

### Choosing the port

```bash
npx jetplane dev --port 8081     # -p, --port=8081 and $PORT all work
```

The default is `8091`. With no explicit port, a busy port makes the server step to the next
free one and print the URLs for it. A port you *did* ask for is strict — if it's taken,
jetplane exits with an error rather than drifting, so a reverse proxy or tunnel pointed at
that port can't end up talking to nothing.

Behind a proxy, also set `EXPO_DEV_SERVER_ORIGIN` (a full origin, e.g.
`https://dev.example.com`) so the manifest advertises the public URL instead of the bind
address.

## Run the benchmarks

```bash
# Metro vs Vite vs Next memory + Metro's cold-bundle spike
node bench/measure.mjs expo-native

# cross-project vendor cache (995 real modules): cold/warm/packed + reuse
node bench/metro-cache-bench.mjs

# thin-server + shared transform service memory
node bench/path2-amortized.mjs
```

Results and methodology: [benchmark.md](./benchmark.md) and the raw docs in
[`../bench/`](../bench/).

## The website

```bash
cd website
npm install
npm run dev     # http://localhost:3000
```

Next.js + shadcn (radix-ui) + Tailwind. The interactive benchmark chart is
`components/benchmark-chart.tsx`.

## Notes

- The plugin (`jetplane/transformer`) is Node-only and ships in the published package. The
  thin dev server and HMR are experimental and run under [Bun](https://bun.sh).
- The shared cache lives under `~/.jetplane`; delete it to reset.

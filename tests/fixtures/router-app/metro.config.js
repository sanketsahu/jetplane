const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

// Enable package.json exports resolution (needed by @supabase/supabase-js subpaths)
config.resolver.unstable_enablePackageExports = true;

const __jetplaneConfig = withNativeWind(config, { input: './global.css' });

// jetplane transform cache — used by the cloud dev servers (orchd images bake
// a warm cache; boots skip re-transforming node_modules). Inert anywhere
// jetplane isn't installed: the editor's browser runtime and plain `expo
// start` hit the catch and run the stock transformer.
try {
  __jetplaneConfig.transformer.upstreamTransformerPath = __jetplaneConfig.transformerPath;
  __jetplaneConfig.transformerPath = require.resolve('jetplane/transformer');
  __jetplaneConfig.cacheStores = [];
} catch {}

module.exports = __jetplaneConfig;


const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const config = getDefaultConfig(__dirname);

// Enable package.json exports resolution (needed by @supabase/supabase-js subpaths)
config.resolver.unstable_enablePackageExports = true;

const __jetplaneConfig = withNativeWind(config, { input: './global.css' });
__jetplaneConfig.transformer = __jetplaneConfig.transformer || {};
__jetplaneConfig.transformer.upstreamTransformerPath = __jetplaneConfig.transformerPath;
__jetplaneConfig.transformerPath = require.resolve('jetplane/transformer');
__jetplaneConfig.cacheStores = [];
module.exports = __jetplaneConfig;

const { merge } = require("webpack-merge");
const common = require("./webpack-common.config");

module.exports = merge(common, {
  mode: "production",
  devtool: false,
  output: {
    filename: "bundle.[contenthash].min.js",
  },
  performance: {
    // Only JS counts; audio and textures are expected to be large. The bundle is ~4 MiB because
    // @dimforge/rapier2d-compat embeds its WASM as base64 (plus three.js). Fine for Tauri
    // downloads; loading the non-compat WASM separately would shrink it for the web.
    assetFilter: (file) => file.endsWith(".js"),
    maxAssetSize: 5 * 1024 * 1024,
    maxEntrypointSize: 5 * 1024 * 1024,
  },
});

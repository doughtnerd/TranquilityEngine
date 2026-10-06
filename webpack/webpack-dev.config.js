const path = require("path");
const webpack = require("webpack");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const CleanWebpackPlugin = require("clean-webpack-plugin");

module.exports = {
  mode: "development",
  entry: "./src/index.ts",
  module: {
    rules: [
      {
        test: /\.[tj]sx?$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
      {
        test: /\.(png|jpg|jpeg|gif|svg|mp3|mp4)/,
        type: "asset/resource",
      },
      {
        test: /\.json$/,
        type: "javascript/auto",
      },
      {
        test: /\.(mp4|webm)/,
        type: "asset/resource",
      },
      {
        test: /\.(vert|frag)$/i,
        type: "asset/source",
      },
    ],
  },
  resolve: {
    extensions: [".ts", ".tsx", ".js"],
    alias: {
      src: "./src/engine",
    },
    preferRelative: true,
  },
  stats: {
    colors: true,
  },
  devtool: "source-map",
  plugins: [
    new CleanWebpackPlugin(["dist"], {
      root: path.resolve(__dirname, "../"),
    }),
    new webpack.DefinePlugin({
      CANVAS_RENDERER: JSON.stringify(true),
      WEBGL_RENDERER: JSON.stringify(true),
    }),
    new HtmlWebpackPlugin({
      template: "./index.html",
    }),
  ],
};

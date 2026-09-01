import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HtmlRspackPlugin } from "@rspack/core";
import { RspackCoveragePlugin } from "../../../dist/index.js";

const directory = dirname(fileURLToPath(import.meta.url));

export default {
  mode: "production",
  context: directory,
  entry: "./index.js",
  devtool: false,
  optimization: { concatenateModules: false, minimize: false },
  output: {
    path: resolve(directory, "dist"),
    filename: "[name].js",
    chunkFilename: "[name].[contenthash:8].js",
    publicPath: "auto",
    clean: true,
  },
  plugins: [
    new HtmlRspackPlugin({ title: "Rspack Coverage Investigation Fixture" }),
    new RspackCoveragePlugin({ port: 49860, open: false }),
  ],
};

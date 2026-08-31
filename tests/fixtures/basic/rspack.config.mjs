import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HtmlRspackPlugin } from "@rspack/core";
import { RspackCoveragePlugin } from "../../../dist/index.js";

const directory = dirname(fileURLToPath(import.meta.url));

export default {
  mode: "production",
  context: directory,
  entry: "./src/index.js",
  output: {
    path: join(directory, "dist"),
    filename: "static/[name].[contenthash:8].js",
    chunkFilename: "static/[name].[contenthash:8].js",
    publicPath: "auto",
    clean: true,
  },
  optimization: {
    splitChunks: { chunks: "all" },
  },
  plugins: [
    new HtmlRspackPlugin({ title: "Rspack Coverage fixture" }),
    new RspackCoveragePlugin({ port: 49920, open: false }),
  ],
};

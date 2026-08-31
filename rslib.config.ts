import { defineConfig } from "@rslib/core";

export default defineConfig({
  source: {
    entry: {
      index: "./src/index.ts",
    },
  },
  lib: [
    {
      format: "esm",
      syntax: "es2022",
      dts: {
        bundle: true,
      },
    },
    {
      format: "cjs",
      syntax: "es2022",
    },
  ],
  output: {
    target: "node",
    distPath: {
      root: "dist",
    },
    cleanDistPath: true,
  },
});

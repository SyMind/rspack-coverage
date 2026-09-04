import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

export default defineConfig({
  plugins: [pluginReact()],
  source: {
    entry: {
      index: "./src/ui/main.tsx",
    },
  },
  html: {
    title: "Rspack Coverage",
    meta: {
      description: "Understand which emitted Rspack code was loaded and executed.",
      viewport: "width=device-width, initial-scale=1",
    },
  },
  output: {
    target: "web",
    distPath: {
      root: "dist/ui",
    },
    cleanDistPath: true,
    sourceMap: {
      js: false,
      css: false,
    },
    assetPrefix: "/__rspack_coverage__/",
  },
  performance: {
    chunkSplit: {
      strategy: "all-in-one",
    },
  },
});

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { analyzeCoverage } from "../../src/analyzer/analyze.js";
import type { BuildManifest, RawSourceMapPayload } from "../../src/shared/types.js";

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 20);
}

describe("lazy original-source analysis", () => {
  it("loads and writes one source detail before reading the next source payload", async () => {
    const generated = "x";
    const build: BuildManifest = {
      hash: "lazy-sources",
      mode: "production",
      context: "/project",
      publicPath: "/",
      builtAt: 1,
      assets: [
        {
          id: "main",
          name: "main.js",
          urlPath: "/main.js",
          size: 1,
          contentHash: hash(generated),
          chunks: ["main"],
          mapAvailable: true,
        },
      ],
      chunks: [
        {
          id: "main",
          names: ["main"],
          files: ["main.js"],
          initial: true,
          entry: true,
          moduleIds: ["module"],
          emittedBytes: 1,
        },
      ],
      modules: [
        {
          id: "module",
          identifier: "/project/src/emitted.js",
          name: "./src/emitted.js",
          resource: "/project/src/emitted.js",
          sourcePaths: ["src/emitted.js"],
          moduleType: "javascript/esm",
          chunks: ["main"],
          issuer: null,
          size: 1,
          usedExports: true,
          providedExports: null,
          optimizationBailout: [],
          nested: false,
        },
      ],
      entrypoints: [{ name: "main", chunks: ["main"], assets: ["main.js"] }],
      diagnostics: [],
      capabilities: {
        usedExports: "enabled",
        sourceMap: "full",
        originalLocations: "exact",
      },
      counts: {
        assets: 1,
        javascriptAssets: 1,
        chunks: 1,
        modules: 1,
        sourceMaps: 1,
      },
      previewAvailable: false,
      publicPathSupported: true,
    };
    const sourcePaths = [
      "src/emitted.js",
      ...Array.from({ length: 64 }, (_, index) => `src/not-emitted-${index}.js`),
    ];
    const sourceMap: RawSourceMapPayload = {
      version: 3,
      sources: ["src/emitted.js"],
      sourcesContent: [null],
      names: [],
      mappings: "AAAA",
    };
    let outstanding = 0;
    let peakOutstanding = 0;
    let details = 0;

    const report = await analyzeCoverage({
      build,
      coverage: [{ url: "/main.js", text: generated, ranges: [{ start: 0, end: 1 }] }],
      maps: { main: sourceMap },
      generatedAssets: { main: generated },
      originalSourcePaths: sourcePaths,
      loadOriginalSource: async (sourceKey) => {
        outstanding += 1;
        peakOutstanding = Math.max(peakOutstanding, outstanding);
        return `// ${sourceKey}`;
      },
      precision: "per-block",
      onFileDetail: () => {
        details += 1;
        outstanding -= 1;
      },
    });

    expect(report.files).toHaveLength(sourcePaths.length);
    expect(details).toBe(sourcePaths.length);
    expect(peakOutstanding).toBe(1);
    expect(outstanding).toBe(0);
  });
});

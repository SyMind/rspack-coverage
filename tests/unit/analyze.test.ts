import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { analyzeCoverage } from "../../src/analyzer/analyze.js";
import type { BuildManifest, RawSourceMapPayload } from "../../src/shared/types.js";

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 20);
}

describe("coverage analysis", () => {
  it("maps executed, unexecuted, not-loaded, not-emitted, and unmapped bytes", async () => {
    const main = "aaaaabbbbb";
    const lazy = "ccccc";
    const build: BuildManifest = {
      hash: "build-1",
      mode: "production",
      context: "/project",
      publicPath: "/",
      builtAt: 1,
      assets: [
        {
          id: "main",
          name: "main.js",
          urlPath: "/main.js",
          size: 10,
          contentHash: hash(main),
          chunks: ["main"],
          mapAvailable: true,
        },
        {
          id: "lazy",
          name: "lazy.js",
          urlPath: "/lazy.js",
          size: 5,
          contentHash: hash(lazy),
          chunks: ["lazy"],
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
          moduleIds: ["module-main"],
          emittedBytes: 10,
        },
        {
          id: "lazy",
          names: ["lazy"],
          files: ["lazy.js"],
          initial: false,
          entry: false,
          moduleIds: ["module-lazy"],
          emittedBytes: 5,
        },
      ],
      modules: [
        {
          id: "module-main",
          identifier: "/project/src/index.js",
          name: "./src/index.js",
          resource: "/project/src/index.js",
          chunks: ["main"],
          issuer: null,
          size: 20,
          usedExports: ["used"],
          providedExports: ["used", "removed"],
          nested: false,
        },
        {
          id: "module-lazy",
          identifier: "/project/src/lazy.js",
          name: "./src/lazy.js",
          resource: "/project/src/lazy.js",
          chunks: ["lazy"],
          issuer: null,
          size: 5,
          usedExports: true,
          providedExports: null,
          nested: false,
        },
      ],
      entrypoints: [{ name: "main", chunks: ["main"], assets: ["main.js"] }],
      diagnostics: [],
      counts: { assets: 3, javascriptAssets: 2, chunks: 2, modules: 2, sourceMaps: 2 },
      previewAvailable: true,
      publicPathSupported: true,
    };
    const maps: Record<string, RawSourceMapPayload> = {
      main: {
        version: 3,
        sources: ["webpack:///./src/index.js"],
        sourcesContent: ["used();\ncold();\nremoved();"],
        names: [],
        mappings: "AAAA,KACA",
      },
      lazy: {
        version: 3,
        sources: ["webpack:///./src/lazy.js"],
        sourcesContent: ["lazy();"],
        names: [],
        mappings: "AAAA",
      },
    };

    const report = await analyzeCoverage({
      build,
      coverage: [
        {
          url: "http://127.0.0.1:4868/main.js?cache=1",
          text: main,
          ranges: [{ start: 0, end: 5 }],
        },
      ],
      maps,
      generatedAssets: { main, lazy },
      originalSources: { "webpack:///./src/fully-removed.js": "never();" },
      precision: "per-block",
    });

    expect(report.metrics).toMatchObject({
      emittedBytes: 15,
      loadedBytes: 10,
      executedBytes: 5,
      unusedBytes: 5,
      notLoadedBytes: 5,
    });
    const mainFile = report.files.find((file) => file.path === "src/index.js");
    expect(mainFile?.lines.map((line) => [line.buildState, line.runtimeState])).toEqual([
      ["retained", "executed"],
      ["retained", "not-executed"],
      ["not-emitted", "not-loaded"],
    ]);
    expect(mainFile?.moduleIds).toEqual(["module-main"]);
    expect(report.files.find((file) => file.path === "src/lazy.js")?.lines[0]?.runtimeState).toBe(
      "not-loaded",
    );
    expect(
      report.files.find((file) => file.path === "src/fully-removed.js")?.lines[0]?.buildState,
    ).toBe("not-emitted");
    expect(report.chunks.find((chunk) => chunk.id === "main")?.loaded).toBe(true);
    expect(report.chunks.find((chunk) => chunk.id === "lazy")?.loaded).toBe(false);
  });

  it("rejects stale generated content instead of producing a report", async () => {
    const text = "current";
    const build: BuildManifest = {
      hash: "build-2",
      mode: "production",
      context: "/",
      publicPath: "/",
      builtAt: 1,
      assets: [
        {
          id: "main",
          name: "main.js",
          urlPath: "/main.js",
          size: text.length,
          contentHash: hash(text),
          chunks: ["1"],
          mapAvailable: false,
        },
      ],
      chunks: [],
      modules: [],
      entrypoints: [],
      diagnostics: [],
      counts: { assets: 1, javascriptAssets: 1, chunks: 0, modules: 0, sourceMaps: 0 },
      previewAvailable: true,
      publicPathSupported: true,
    };
    await expect(
      analyzeCoverage({
        build,
        coverage: [{ url: "/main.js", text: "stale", ranges: [{ start: 0, end: 5 }] }],
        maps: {},
        generatedAssets: { main: text },
        originalSources: {},
        precision: "unknown",
      }),
    ).rejects.toThrow(/does not match build/);
  });
});

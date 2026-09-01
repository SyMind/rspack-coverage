import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { analyzeCoverage, materializeSourceFileDetail } from "../../src/analyzer/analyze.js";
import type {
  BuildManifest,
  RawSourceMapPayload,
  SourceFileDetail,
} from "../../src/shared/types.js";

const FULL_CAPABILITIES: BuildManifest["capabilities"] = {
  usedExports: "enabled",
  sourceMap: "full",
  originalLocations: "exact",
};

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
          moduleType: "javascript/auto",
          chunks: ["main"],
          issuer: null,
          size: 20,
          usedExports: ["used"],
          providedExports: ["used", "removed"],
          optimizationBailout: [],
          nested: false,
        },
        {
          id: "module-lazy",
          identifier: "/project/src/lazy.js",
          name: "./src/lazy.js",
          resource: "/project/src/lazy.js",
          moduleType: "javascript/auto",
          chunks: ["lazy"],
          issuer: null,
          size: 5,
          usedExports: true,
          providedExports: null,
          optimizationBailout: [],
          nested: false,
        },
      ],
      entrypoints: [{ name: "main", chunks: ["main"], assets: ["main.js"] }],
      diagnostics: [],
      capabilities: FULL_CAPABILITIES,
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

    const progress: Array<[string, number, number]> = [];
    const details = new Map<string, SourceFileDetail>();
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
      onProgress: (phase, completed, total) => progress.push([phase, completed, total]),
      onFileDetail: (file) => {
        details.set(file.id, materializeSourceFileDetail(file));
      },
    });

    expect(report.metrics).toMatchObject({
      emittedBytes: 15,
      loadedBytes: 10,
      executedBytes: 5,
      unusedBytes: 5,
      notLoadedBytes: 5,
    });
    const mainFile = report.files.find((file) => file.path === "src/index.js");
    expect(
      details.get("src/index.js")?.lines.map((line) => [line.buildState, line.runtimeState]),
    ).toEqual([
      ["retained", "executed"],
      ["retained", "not-executed"],
      ["not-emitted", "not-loaded"],
    ]);
    expect(mainFile?.moduleIds).toEqual(["module-main"]);
    expect(details.get("src/lazy.js")?.lines[0]?.runtimeState).toBe("not-loaded");
    expect(details.get("src/fully-removed.js")?.lines[0]?.buildState).toBe("not-emitted");
    expect(report.chunks.find((chunk) => chunk.id === "main")?.loaded).toBe(true);
    expect(report.chunks.find((chunk) => chunk.id === "lazy")?.loaded).toBe(false);
    expect(progress).toContainEqual(["Mapping generated code", 2, 2]);
    expect(progress).toContainEqual(["Building file reports", 0, 3]);
    expect(progress).toContainEqual(["Building file reports", 3, 3]);
    expect(progress).toContainEqual(["Aggregating report", 0, 1]);
    expect(progress).toContainEqual(["Aggregating report", 1, 1]);
  });

  it("keeps captured original source instead of compacted source-map content", async () => {
    const text = "x";
    const build: BuildManifest = {
      hash: "build-original-source",
      mode: "production",
      context: "/project/app",
      publicPath: "/",
      builtAt: 1,
      assets: [
        {
          id: "main",
          name: "main.js",
          urlPath: "/main.js",
          size: text.length,
          contentHash: hash(text),
          chunks: ["main"],
          mapAvailable: true,
        },
      ],
      chunks: [],
      modules: [],
      entrypoints: [],
      diagnostics: [],
      capabilities: FULL_CAPABILITIES,
      counts: { assets: 1, javascriptAssets: 1, chunks: 0, modules: 0, sourceMaps: 1 },
      previewAvailable: true,
      publicPathSupported: true,
    };
    const original = "import { value } from './value';\nexport const result = value;\n";
    const details = new Map<string, SourceFileDetail>();

    await analyzeCoverage({
      build,
      coverage: [{ url: "/main.js", text, ranges: [{ start: 0, end: 1 }] }],
      maps: {
        main: {
          version: 3,
          sources: ["webpack:///shared/pkg/source.ts"],
          sourcesContent: ["import{value}from'./value';export const result=value;"],
          names: [],
          mappings: "AAAA",
        },
      },
      generatedAssets: { main: text },
      originalSources: {
        "/outside/worktree/shared/pkg/source.ts": original,
      },
      precision: "per-block",
      onFileDetail: (file) => {
        details.set(file.id, materializeSourceFileDetail(file));
      },
    });

    expect(
      details
        .get("shared/pkg/source.ts")
        ?.lines.map((line) => line.text)
        .join("\n"),
    ).toBe(original);
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
      capabilities: {
        usedExports: "disabled",
        sourceMap: "none",
        originalLocations: "unavailable",
      },
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

  it("matches source modules through indexed exact and suffix paths", async () => {
    const text = "covered";
    const build: BuildManifest = {
      hash: "build-indexed-modules",
      mode: "production",
      context: "/project",
      publicPath: "/",
      builtAt: 1,
      assets: [
        {
          id: "main",
          name: "main.js",
          urlPath: "/main.js",
          size: text.length,
          contentHash: hash(text),
          chunks: ["main"],
          mapAvailable: false,
        },
      ],
      chunks: [],
      modules: [
        {
          id: "longer-resource",
          identifier: "/workspace/project/src/feature.js",
          name: "./src/feature.js",
          resource: "/workspace/project/src/feature.js",
          moduleType: "javascript/auto",
          chunks: ["feature"],
          issuer: null,
          size: 1,
          usedExports: true,
          providedExports: null,
          optimizationBailout: [],
          nested: false,
        },
        {
          id: "shorter-resource",
          identifier: "/project/src/shared.js",
          name: "./src/shared.js",
          resource: "/project/src/shared.js",
          moduleType: "javascript/auto",
          chunks: ["shared"],
          issuer: null,
          size: 1,
          usedExports: true,
          providedExports: null,
          optimizationBailout: [],
          nested: false,
        },
      ],
      entrypoints: [],
      diagnostics: [],
      capabilities: {
        usedExports: "enabled",
        sourceMap: "none",
        originalLocations: "unavailable",
      },
      counts: { assets: 1, javascriptAssets: 1, chunks: 0, modules: 2, sourceMaps: 0 },
      previewAvailable: true,
      publicPathSupported: true,
    };

    const report = await analyzeCoverage({
      build,
      coverage: [{ url: "/main.js", text, ranges: [{ start: 0, end: text.length }] }],
      generatedAssets: { main: text },
      originalSources: {
        "src/feature.js": "feature();",
        "packages/app/src/shared.js": "shared();",
      },
      precision: "per-block",
    });

    expect(report.files.find((file) => file.path === "src/feature.js")).toMatchObject({
      moduleIds: ["longer-resource"],
      chunks: ["feature"],
    });
    expect(report.files.find((file) => file.path === "packages/app/src/shared.js")).toMatchObject({
      moduleIds: ["shorter-resource"],
      chunks: ["shared"],
    });
  });

  it("uses one executed state for a partially covered source line", async () => {
    const text = "aaaaabbbbb";
    const build: BuildManifest = {
      hash: "build-line",
      mode: "production",
      context: "/project",
      publicPath: "/",
      builtAt: 1,
      assets: [
        {
          id: "main",
          name: "main.js",
          urlPath: "/main.js",
          size: text.length,
          contentHash: hash(text),
          chunks: ["main"],
          mapAvailable: true,
        },
      ],
      chunks: [],
      modules: [],
      entrypoints: [],
      diagnostics: [],
      capabilities: FULL_CAPABILITIES,
      counts: { assets: 1, javascriptAssets: 1, chunks: 0, modules: 0, sourceMaps: 1 },
      previewAvailable: true,
      publicPathSupported: true,
    };
    const details = new Map<string, SourceFileDetail>();
    await analyzeCoverage({
      build,
      coverage: [{ url: "/main.js", text, ranges: [{ start: 0, end: 5 }] }],
      maps: {
        main: {
          version: 3,
          sources: ["/project/src/one-line.js"],
          sourcesContent: ["run();"],
          names: [],
          mappings: "AAAA,KAAA",
        },
      },
      generatedAssets: { main: text },
      originalSources: {},
      precision: "per-block",
      onFileDetail: (file) => {
        details.set(file.id, materializeSourceFileDetail(file));
      },
    });

    const line = details.get("src/one-line.js")?.lines[0];
    expect(line?.runtimeState).toBe("executed");
    expect(new Set(line?.ranges.map((range) => range.executed))).toEqual(new Set([true]));
  });

  it("does not create empty rows beyond available sourcesContent", async () => {
    const text = "generated";
    const build: BuildManifest = {
      hash: "build-content",
      mode: "production",
      context: "/project",
      publicPath: "/",
      builtAt: 1,
      assets: [
        {
          id: "main",
          name: "main.js",
          urlPath: "/main.js",
          size: text.length,
          contentHash: hash(text),
          chunks: ["main"],
          mapAvailable: true,
        },
      ],
      chunks: [],
      modules: [],
      entrypoints: [],
      diagnostics: [],
      capabilities: FULL_CAPABILITIES,
      counts: { assets: 1, javascriptAssets: 1, chunks: 0, modules: 0, sourceMaps: 1 },
      previewAvailable: true,
      publicPathSupported: true,
    };
    const details = new Map<string, SourceFileDetail>();
    await analyzeCoverage({
      build,
      coverage: [{ url: "/main.js", text, ranges: [{ start: 0, end: text.length }] }],
      maps: {
        main: {
          version: 3,
          sources: ["/project/src/single-line.js"],
          sourcesContent: ["singleLine();"],
          names: [],
          mappings: "AAKA",
        },
      },
      generatedAssets: { main: text },
      originalSources: {},
      precision: "per-block",
      onFileDetail: (file) => {
        details.set(file.id, materializeSourceFileDetail(file));
      },
    });

    expect(details.get("src/single-line.js")?.lines).toHaveLength(1);
  });
});

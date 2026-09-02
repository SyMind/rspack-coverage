import { createReadStream } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  importPortableSnapshot,
  writePortableSnapshotFile,
} from "../../src/server/portableSnapshot.js";
import {
  loadLatestBuildSnapshot,
  persistBuildSnapshot,
  resolveCoverageDataDirectory,
} from "../../src/server/snapshotStorage.js";
import type { BuildSnapshot, RawSourceMapPayload } from "../../src/shared/types.js";

const sourceMap: RawSourceMapPayload = {
  version: 3,
  file: "main.js",
  sources: ["src/index.js"],
  sourcesContent: ["export const value = 1;"],
  names: [],
  mappings: "AAAA",
};

function snapshot(context: string, builtAt: number, loadCodeGeneration = vi.fn()): BuildSnapshot {
  return {
    manifest: {
      hash: "persisted-build",
      mode: "production",
      context,
      publicPath: "/",
      builtAt,
      assets: [
        {
          id: "main-asset",
          name: "main.js",
          urlPath: "/main.js",
          size: 23,
          contentHash: "01234567890123456789",
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
          emittedBytes: 23,
        },
      ],
      modules: [
        {
          id: "module",
          identifier: `${context}/src/index.js`,
          name: "./src/index.js",
          resource: `${context}/src/index.js`,
          moduleType: "javascript/esm",
          chunks: ["main"],
          issuer: null,
          entry: true,
          size: 23,
          usedExports: ["value"],
          providedExports: ["value"],
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
        assets: 2,
        javascriptAssets: 1,
        chunks: 1,
        modules: 1,
        sourceMaps: 1,
        references: 1,
      },
      previewAvailable: true,
      publicPathSupported: true,
    },
    assets: new Map([
      ["main-asset", Buffer.from("export const value = 1;")],
      ["html:index.html", Buffer.from("<!doctype html><script src=/main.js></script>")],
    ]),
    maps: new Map([["main-asset", sourceMap]]),
    originalSources: new Map([["src/index.js", "export const value = 1;"]]),
    exportGraph: {
      modules: [
        {
          id: "module",
          identifier: `${context}/src/index.js`,
          resource: `${context}/src/index.js`,
          moduleType: "javascript/esm",
          chunks: ["main"],
          providedExports: ["value"],
          usedExports: ["value"],
          optimizationBailout: [],
          originalSources: ["src/index.js"],
          transformedSource: "export const value = 1;",
          sourceMap,
        },
      ],
      edges: [
        {
          originModuleId: "module",
          targetModuleId: "module",
          resolvedModuleId: "module",
          dependencyType: "esm import",
          request: "./index.js",
          referencedPath: ["value"],
          location: null,
          active: true,
        },
      ],
      sourceToModuleIds: { "src/index.js": ["module"] },
    },
    references: [
      {
        id: "reference",
        originId: "module",
        targetId: "module",
        dependencyType: "esm import",
        request: "./index.js",
        exports: ["value"],
        active: true,
        location: null,
      },
    ],
    codeGeneration: new Map(),
    loadCodeGeneration: (moduleId) => {
      loadCodeGeneration(moduleId);
      return moduleId === "module"
        ? [
            {
              moduleId,
              runtimes: [["main"]],
              content: "const value = 1;",
              map: null,
              mapError: "not mapped",
            },
          ]
        : [];
    },
    outputPath: join(context, "dist"),
    indexAsset: "index.html",
  };
}

describe("persistent build snapshots", () => {
  let directory: string | null = null;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = null;
  });

  it("round-trips every analysis data family and reuses identical content", async () => {
    directory = await mkdtemp(join(tmpdir(), "rspack-coverage-snapshot-"));
    const dataDirectory = join(directory, "cache");
    const loadCodeGeneration = vi.fn();
    const first = await persistBuildSnapshot(
      snapshot(directory, 100, loadCodeGeneration),
      dataDirectory,
    );
    expect(first.storage?.snapshotId).toMatch(/^v2-[a-f0-9]{32}$/);
    expect(first.manifest.counts.codeGenerationSources).toBe(1);
    expect(loadCodeGeneration).toHaveBeenCalledWith("module");
    expect(first.assets.get("main-asset")?.toString()).toBe("export const value = 1;");
    expect(first.maps.get("main-asset")).toEqual(sourceMap);
    expect(first.originalSources.get("src/index.js")).toBe("export const value = 1;");
    expect(first.codeGeneration.get("module")?.[0]?.content).toBe("const value = 1;");

    const recording = join(first.storage?.directory ?? "", "coverage.json");
    first.dispose?.();
    await writeFile(recording, "[]");
    const second = await persistBuildSnapshot(snapshot(directory, 200), dataDirectory);
    expect(second.storage?.snapshotId).toBe(first.storage?.snapshotId);
    expect(await readFile(join(second.storage?.directory ?? "", "coverage.json"), "utf8")).toBe(
      "[]",
    );
    second.dispose?.();

    const loaded = await loadLatestBuildSnapshot(dataDirectory);
    expect(loaded.storage?.snapshotId).toBe(first.storage?.snapshotId);
    expect(loaded.manifest.hash).toBe("persisted-build");
    expect(loaded.assets.get("html:index.html")?.toString()).toContain("<script");
    expect(loaded.originalSources.get("src/index.js")).toBe("export const value = 1;");
    expect(loaded.codeGeneration.get("module")?.[0]).toMatchObject({
      moduleId: "module",
      content: "const value = 1;",
    });
    expect(loaded.exportGraph).toEqual({ modules: [], edges: [], sourceToModuleIds: {} });
    expect(loaded.references).toEqual([]);
    expect(loaded.exportGraphStore?.moduleIdsForSource("src/index.js")).toEqual(["module"]);
    expect(loaded.exportGraphStore?.getModule("module")?.id).toBe("module");
    expect(
      loaded.exportGraphStore?.edgesForTargets(new Set(["module"]))[0]?.referencedPath,
    ).toEqual(["value"]);
    expect(loaded.referenceStore?.get("reference")?.id).toBe("reference");
    expect(loaded.referenceStore?.page("module", "in", 0, 10)).toHaveLength(1);
    loaded.dispose?.();
  });

  it("resolves the default cache from the compiler context", () => {
    expect(resolveCoverageDataDirectory("/project", undefined)).toBe(
      "/project/node_modules/.cache/rspack-coverage",
    );
    expect(resolveCoverageDataDirectory("/project", ".coverage-data")).toBe(
      "/project/.coverage-data",
    );
    expect(resolveCoverageDataDirectory("/project", false)).toBeNull();
  });

  it("retains only the current and immediately previous distinct snapshots", async () => {
    directory = await mkdtemp(join(tmpdir(), "rspack-coverage-retention-"));
    const dataDirectory = join(directory, "cache");
    for (const hash of ["build-one", "build-two", "build-three"]) {
      const build = snapshot(directory, 100);
      build.manifest.hash = hash;
      const persisted = await persistBuildSnapshot(build, dataDirectory);
      persisted.dispose?.();
    }
    const snapshots = (await readdir(join(dataDirectory, "snapshots"))).filter((name) =>
      name.startsWith("v2-"),
    );
    expect(snapshots).toHaveLength(2);
    const latest = await loadLatestBuildSnapshot(dataDirectory);
    expect(latest.manifest.hash).toBe("build-three");
    latest.dispose?.();
  });

  it("materializes and releases code generation one module at a time", async () => {
    directory = await mkdtemp(join(tmpdir(), "rspack-coverage-codegen-memory-"));
    const dataDirectory = join(directory, "cache");
    const build = snapshot(directory, 100);
    const template = build.manifest.modules[0];
    if (!template) throw new Error("Missing module fixture");
    build.manifest.modules = Array.from({ length: 24 }, (_, index) => ({
      ...template,
      id: `module-${index}`,
      identifier: `${template.identifier}?${index}`,
      name: `${template.name}?${index}`,
    }));
    const active = new Set<string>();
    let peakActive = 0;
    build.loadCodeGeneration = (moduleId) => {
      active.add(moduleId);
      peakActive = Math.max(peakActive, active.size);
      return [
        {
          moduleId,
          runtimes: [["main"]],
          content: "x".repeat(256 * 1024),
          map: null,
          mapError: "not mapped",
        },
      ];
    };
    build.releaseCodeGeneration = (moduleId) => {
      active.delete(moduleId);
    };

    const persisted = await persistBuildSnapshot(build, dataDirectory);
    expect(peakActive).toBe(1);
    expect(active.size).toBe(0);
    expect(persisted.manifest.counts.codeGenerationSources).toBe(24);
    persisted.dispose?.();
  });

  it("round-trips a single portable file without materializing its payload set", async () => {
    directory = await mkdtemp(join(tmpdir(), "rspack-coverage-portable-"));
    const sourceDataDirectory = join(directory, "source-cache");
    const targetDataDirectory = join(directory, "target-cache");
    const archiveFile = join(directory, "build.rspack-coverage");
    const persisted = await persistBuildSnapshot(snapshot(directory, 100), sourceDataDirectory);
    const persistedDirectory = persisted.storage?.directory;
    if (!persistedDirectory) throw new Error("Missing persisted snapshot directory");
    await writeFile(join(persistedDirectory, "coverage.json"), "[]");
    await writeFile(join(persistedDirectory, "report.json"), '{"status":"complete"}');
    await writeFile(join(persistedDirectory, "report.sources"), "source detail");
    await writeFile(join(persistedDirectory, "report.sources.index.json"), '{"version":1}');

    await writePortableSnapshotFile(persisted, archiveFile);
    expect((await stat(archiveFile)).size).toBeGreaterThan(0);
    const sourceId = persisted.storage?.snapshotId;
    persisted.dispose?.();

    const imported = await importPortableSnapshot(
      createReadStream(archiveFile),
      targetDataDirectory,
    );
    expect(imported.snapshot.storage?.snapshotId).toBe(sourceId);
    expect(imported.snapshot.assets.get("main-asset")?.toString()).toBe("export const value = 1;");
    expect(imported.snapshot.originalSources.get("src/index.js")).toBe("export const value = 1;");
    expect(
      await readFile(join(imported.snapshot.storage?.directory ?? "", "coverage.json"), "utf8"),
    ).toBe("[]");
    expect(
      await readFile(join(imported.snapshot.storage?.directory ?? "", "report.sources"), "utf8"),
    ).toBe("source detail");
    imported.snapshot.dispose?.();

    const latest = await loadLatestBuildSnapshot(targetDataDirectory);
    expect(latest.storage?.snapshotId).toBe(sourceId);
    latest.dispose?.();
  });

  it("rejects a truncated portable file without changing the active snapshot", async () => {
    directory = await mkdtemp(join(tmpdir(), "rspack-coverage-portable-invalid-"));
    const sourceDataDirectory = join(directory, "source-cache");
    const targetDataDirectory = join(directory, "target-cache");
    const archiveFile = join(directory, "truncated.rspack-coverage");
    const source = await persistBuildSnapshot(snapshot(directory, 100), sourceDataDirectory);
    await writePortableSnapshotFile(source, archiveFile);
    source.dispose?.();
    await truncate(archiveFile, (await stat(archiveFile)).size - 10);

    const targetBuild = snapshot(directory, 200);
    targetBuild.manifest.hash = "existing-target-build";
    const target = await persistBuildSnapshot(targetBuild, targetDataDirectory);
    target.dispose?.();

    await expect(
      importPortableSnapshot(createReadStream(archiveFile), targetDataDirectory),
    ).rejects.toThrow(/ended unexpectedly|checksum/i);
    const latest = await loadLatestBuildSnapshot(targetDataDirectory);
    expect(latest.manifest.hash).toBe("existing-target-build");
    latest.dispose?.();
    expect(
      (await readdir(join(targetDataDirectory, "snapshots"))).some((name) =>
        name.startsWith(".import-"),
      ),
    ).toBe(false);
  });
});

import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StoredSourceFileDetail } from "../../src/analyzer/analyze.js";
import { CoverageAnalysisService } from "../../src/server/CoverageAnalysisService.js";
import type { CoverageFileDetailIndex } from "../../src/server/coverageAnalysisRunner.js";
import type { BuildManifest, BuildSnapshot } from "../../src/shared/types.js";

function manifest(): BuildManifest {
  return {
    hash: "build",
    mode: "production",
    context: "/project/packages/app",
    publicPath: "/",
    builtAt: 1,
    assets: [],
    chunks: [],
    modules: [],
    entrypoints: [],
    diagnostics: [],
    capabilities: {
      usedExports: "enabled",
      sourceMap: "full",
      originalLocations: "exact",
    },
    counts: {
      assets: 0,
      javascriptAssets: 0,
      chunks: 0,
      modules: 0,
      sourceMaps: 0,
      references: 0,
      codeGenerationSources: 0,
    },
    previewAvailable: false,
    publicPathSupported: true,
  };
}

function snapshot(directory: string): BuildSnapshot {
  return {
    manifest: manifest(),
    assets: new Map(),
    maps: new Map(),
    originalSources: new Map(),
    exportGraph: { modules: [], edges: [], sourceToModuleIds: {} },
    references: [],
    codeGeneration: new Map(),
    outputPath: "/project/dist",
    indexAsset: null,
    storage: { version: 2, snapshotId: "snapshot", directory },
  };
}

async function writeDetails(directory: string, details: StoredSourceFileDetail[]): Promise<void> {
  const payloads = details.map((detail) => Buffer.from(JSON.stringify(detail)));
  let offset = 0;
  const entries: CoverageFileDetailIndex["entries"] = {};
  for (let index = 0; index < details.length; index += 1) {
    const detail = details[index];
    const payload = payloads[index];
    if (!detail || !payload) continue;
    entries[detail.id] = { offset, length: payload.byteLength };
    offset += payload.byteLength;
  }
  await Promise.all([
    writeFile(join(directory, "report.json"), "{}"),
    writeFile(join(directory, "report.sources"), Buffer.concat(payloads)),
    writeFile(
      join(directory, "report.sources.index.json"),
      JSON.stringify({ version: 1, entries } satisfies CoverageFileDetailIndex),
    ),
  ]);
}

describe("CoverageAnalysisService", () => {
  let directory: string | null = null;
  let service: CoverageAnalysisService | null = null;

  afterEach(async () => {
    await service?.close();
    service = null;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = null;
  });

  it("uses a retained same-content alias for a reference line in an old snapshot", async () => {
    directory = await mkdtemp(join(tmpdir(), "rspack-coverage-source-alias-"));
    const content = "withField(Component);";
    const duplicateId = "project/node_modules/pkg/form/field.js";
    const retainedId = "node_modules/pkg/form/field.js";
    await writeDetails(directory, [
      {
        id: duplicateId,
        content,
        sourceMapAvailable: true,
        chunks: [],
        mappedLines: [],
      },
      {
        id: retainedId,
        content,
        sourceMapAvailable: true,
        chunks: ["98787"],
        mappedLines: [
          {
            lineIndex: 0,
            emittedBytes: 22,
            loadedBytes: 0,
            executedBytes: 0,
            chunks: ["98787"],
            ranges: [],
          },
        ],
      },
    ]);
    service = new CoverageAnalysisService();
    service.update(snapshot(directory));

    expect((await service.source("build", duplicateId)).id).toBe(duplicateId);
    const selected = await service.source("build", duplicateId, "consumer", 1);
    expect(selected).toMatchObject({
      id: retainedId,
      lines: [
        {
          buildState: "retained",
          runtimeState: "not-loaded",
          emittedBytes: 22,
        },
      ],
    });
  });

  it("pages the containing generated asset for an unmapped runtime source", async () => {
    directory = await mkdtemp(join(tmpdir(), "rspack-coverage-generated-fallback-"));
    const generated = "const hot = 1;\nconst cold = 2;\n";
    const executedEnd = generated.indexOf("\n") + 1;
    const build = manifest();
    build.assets = [
      {
        id: "main",
        name: "static/js/main.js",
        urlPath: "/static/js/main.js",
        size: Buffer.byteLength(generated),
        contentHash: createHash("sha256").update(generated).digest("hex").slice(0, 20),
        chunks: ["main"],
        mapAvailable: false,
      },
    ];
    const fileId = "[rspack runtime / unmapped]/static/js/main.js";
    await Promise.all([
      writeDetails(directory, [
        {
          id: fileId,
          content: null,
          sourceMapAvailable: false,
          chunks: ["main"],
          mappedLines: [],
        },
      ]),
      writeFile(
        join(directory, "coverage.json"),
        JSON.stringify([
          {
            url: "http://localhost/static/js/main.js",
            text: generated,
            ranges: [{ start: 0, end: executedEnd }],
          },
        ]),
      ),
    ]);
    const storedSnapshot: BuildSnapshot = {
      ...snapshot(directory),
      manifest: build,
      assets: new Map([["main", Buffer.from(generated)]]),
    };
    service = new CoverageAnalysisService();
    service.update(storedSnapshot);

    const code = await service.generatedSource("build", fileId);
    expect(code).toMatchObject({
      view: "output",
      sourceId: fileId,
      filename: "static/js/main.js",
      content: generated,
      offset: 0,
      endOffset: generated.length,
      startLine: 1,
      totalCharacters: generated.length,
      hasPrevious: false,
      hasNext: false,
    });
    expect(code.spans).toEqual([
      { start: 0, end: executedEnd, status: "executed" },
      { start: executedEnd, end: generated.length, status: "unexecuted" },
    ]);

    const page = await service.generatedSource("build", fileId, executedEnd, 5);
    expect(page).toMatchObject({
      content: generated.slice(executedEnd, executedEnd + 5),
      offset: executedEnd,
      endOffset: executedEnd + 5,
      startLine: 2,
      hasPrevious: true,
      hasNext: true,
    });
    expect(page.spans).toEqual([{ start: 0, end: 5, status: "unexecuted" }]);
  });
});

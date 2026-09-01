import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  materializeSourceFileDetail,
  type StoredSourceFileDetail,
} from "../../src/analyzer/analyze.js";
import type { CoverageFileDetailIndex } from "../../src/server/coverageAnalysisRunner.js";
import {
  runCoverageAnalysisJob,
  type StagedCoverageSnapshot,
} from "../../src/server/coverageAnalysisRunner.js";
import type { CoverageAnalysisStatus, SourceFileDetail } from "../../src/shared/types.js";

describe("coverage analysis runner", () => {
  let directory: string | null = null;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = null;
  });

  it("reports serialization and report writing as independent phases", async () => {
    directory = await mkdtemp(join(tmpdir(), "rspack-coverage-runner-"));
    await mkdir(join(directory, "assets"));
    const generated = "console.log('covered');";
    const staged: StagedCoverageSnapshot = {
      build: {
        hash: "runner-build",
        mode: "production",
        context: "/project",
        publicPath: "/",
        builtAt: 1,
        assets: [
          {
            id: "main",
            name: "main.js",
            urlPath: "/main.js",
            size: Buffer.byteLength(generated),
            contentHash: createHash("sha256").update(generated).digest("hex").slice(0, 20),
            chunks: ["main"],
            mapAvailable: false,
          },
        ],
        chunks: [
          {
            id: "main",
            names: ["main"],
            files: ["main.js"],
            initial: true,
            entry: true,
            moduleIds: [],
            emittedBytes: Buffer.byteLength(generated),
          },
        ],
        modules: [],
        entrypoints: [{ name: "main", chunks: ["main"], assets: ["main.js"] }],
        diagnostics: [],
        capabilities: {
          usedExports: "disabled",
          sourceMap: "none",
          originalLocations: "unavailable",
        },
        counts: { assets: 1, javascriptAssets: 1, chunks: 1, modules: 0, sourceMaps: 0 },
        previewAvailable: true,
        publicPathSupported: true,
      },
      assets: { main: { contentFile: "assets/main.js", mapFile: null } },
      sources: [],
    };
    const recordingFile = join(directory, "coverage.json");
    const reportFile = join(directory, "report.json");
    const detailsFile = join(directory, "report.sources");
    const detailsIndexFile = join(directory, "report.sources.index.json");
    await Promise.all([
      writeFile(join(directory, "assets/main.js"), generated),
      writeFile(join(directory, "snapshot.json"), JSON.stringify(staged)),
      writeFile(
        recordingFile,
        JSON.stringify([
          {
            url: "/main.js",
            text: generated,
            ranges: [{ start: 0, end: generated.length }],
          },
        ]),
      ),
    ]);

    const progress: Array<[string, number, number]> = [];
    await runCoverageAnalysisJob(
      {
        id: "job-1",
        stageDirectory: directory,
        recordingFile,
        reportFile,
        detailsFile,
        detailsIndexFile,
        precision: "per-block",
      },
      (phase, completed, total) => progress.push([phase, completed, total]),
    );

    expect(progress).toContainEqual(["Building file reports", 0, 1]);
    expect(progress).toContainEqual(["Building file reports", 1, 1]);
    expect(progress).toContainEqual(["Serializing report", 0, 1]);
    expect(progress).toContainEqual(["Serializing report", 1, 1]);
    expect(progress).toContainEqual(["Writing report", 0, 1]);
    expect(progress).toContainEqual(["Writing report", 1, 1]);
    const result = JSON.parse(await readFile(reportFile, "utf8")) as CoverageAnalysisStatus;
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("Coverage analysis did not complete");
    expect(result.report.version).toBe(2);
    expect(result.report.files[0]).not.toHaveProperty("content");
    expect(result.report.files[0]).not.toHaveProperty("lines");

    const index = JSON.parse(await readFile(detailsIndexFile, "utf8")) as CoverageFileDetailIndex;
    const location = index.entries["[rspack runtime / unmapped]/main.js"];
    expect(location).toBeDefined();
    const details = await readFile(detailsFile);
    const stored = JSON.parse(
      details
        .subarray(location?.offset, (location?.offset ?? 0) + (location?.length ?? 0))
        .toString(),
    ) as StoredSourceFileDetail;
    expect(stored).not.toHaveProperty("lines");
    expect(stored.mappedLines).toEqual([]);
    const detail: SourceFileDetail = materializeSourceFileDetail(stored);
    expect(detail.id).toBe("[rspack runtime / unmapped]/main.js");
    expect(detail.lines).toEqual([]);
  });
});

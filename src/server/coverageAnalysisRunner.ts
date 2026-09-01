import { type FileHandle, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeCoverage, type StoredSourceFileDetail } from "../analyzer/analyze.js";
import type {
  BuildManifest,
  ChromeCoverageEntry,
  CoverageAnalysisStatus,
  CoverageImportSummary,
  CoverageReport,
  RawSourceMapPayload,
} from "../shared/types.js";

const DETAIL_BUFFER_BYTES = 4 * 1024 * 1024;

export interface CoverageFileDetailLocation {
  offset: number;
  length: number;
}

export interface CoverageFileDetailIndex {
  version: 1;
  entries: Record<string, CoverageFileDetailLocation>;
}

async function writeFully(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
  let written = 0;
  while (written < buffer.byteLength) {
    const result = await handle.write(
      buffer,
      written,
      buffer.byteLength - written,
      position + written,
    );
    if (result.bytesWritten === 0) throw new Error("Unable to write Coverage source details.");
    written += result.bytesWritten;
  }
}

class CoverageFileDetailWriter {
  #buffers: Buffer[] = [];
  #bufferedBytes = 0;
  #closed = false;
  #entries = Object.create(null) as Record<string, CoverageFileDetailLocation>;
  #nextOffset = 0;
  #writtenOffset = 0;

  private constructor(private readonly handle: FileHandle) {}

  static async create(file: string): Promise<CoverageFileDetailWriter> {
    return new CoverageFileDetailWriter(await open(file, "wx"));
  }

  async write(file: StoredSourceFileDetail): Promise<void> {
    const payload = Buffer.from(JSON.stringify(file));
    this.#entries[file.id] = { offset: this.#nextOffset, length: payload.byteLength };
    this.#nextOffset += payload.byteLength;

    if (payload.byteLength >= DETAIL_BUFFER_BYTES) {
      await this.#flush();
      await writeFully(this.handle, payload, this.#writtenOffset);
      this.#writtenOffset += payload.byteLength;
      return;
    }

    this.#buffers.push(payload);
    this.#bufferedBytes += payload.byteLength;
    if (this.#bufferedBytes >= DETAIL_BUFFER_BYTES) await this.#flush();
  }

  async finish(indexFile: string): Promise<void> {
    await this.#flush();
    await this.#close();
    const index: CoverageFileDetailIndex = { version: 1, entries: this.#entries };
    await writeFile(indexFile, JSON.stringify(index));
  }

  async abort(): Promise<void> {
    await this.#close().catch(() => undefined);
  }

  async #flush(): Promise<void> {
    if (this.#bufferedBytes === 0) return;
    const payload =
      this.#buffers.length === 1
        ? (this.#buffers[0] as Buffer)
        : Buffer.concat(this.#buffers, this.#bufferedBytes);
    this.#buffers = [];
    this.#bufferedBytes = 0;
    await writeFully(this.handle, payload, this.#writtenOffset);
    this.#writtenOffset += payload.byteLength;
  }

  async #close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.handle.close();
  }
}

export interface StagedCoverageAsset {
  contentFile: string;
  mapFile: string | null;
}

export interface StagedCoverageSource {
  path: string;
  contentFile: string;
}

export interface StagedCoverageSnapshot {
  build: BuildManifest;
  assets: Record<string, StagedCoverageAsset>;
  sources: StagedCoverageSource[];
}

export interface CoverageAnalysisWorkerData {
  id: string;
  stageDirectory: string;
  recordingFile: string;
  reportFile: string;
  detailsFile: string;
  detailsIndexFile: string;
  precision: CoverageImportSummary["precision"];
}

export async function runCoverageAnalysisJob(
  input: CoverageAnalysisWorkerData,
  onProgress?: (phase: string, completed: number, total: number) => void,
): Promise<void> {
  onProgress?.("Reading build snapshot", 0, 1);
  const staged = JSON.parse(
    await readFile(join(input.stageDirectory, "snapshot.json"), "utf8"),
  ) as StagedCoverageSnapshot;
  const coverage = JSON.parse(await readFile(input.recordingFile, "utf8")) as unknown;
  if (!Array.isArray(coverage)) throw new Error("Chrome Coverage JSON must contain an array.");

  const originalSources: Record<string, string> = {};
  for (let index = 0; index < staged.sources.length; index += 1) {
    const source = staged.sources[index];
    if (!source) continue;
    onProgress?.("Loading original sources", index, staged.sources.length);
    originalSources[source.path] = await readFile(
      join(input.stageDirectory, source.contentFile),
      "utf8",
    );
  }

  const temporaryDetails = `${input.detailsFile}.tmp`;
  const temporaryDetailsIndex = `${input.detailsIndexFile}.tmp`;
  const detailWriter = await CoverageFileDetailWriter.create(temporaryDetails);
  let report: CoverageReport;
  try {
    report = await analyzeCoverage({
      build: staged.build,
      coverage: coverage as ChromeCoverageEntry[],
      originalSources,
      precision: input.precision,
      ...(onProgress ? { onProgress } : {}),
      onFileDetail: (file) => detailWriter.write(file),
      loadAsset: async (assetId, needsGeneratedSource) => {
        const asset = staged.assets[assetId];
        if (!asset) return {};
        const generated = needsGeneratedSource
          ? await readFile(join(input.stageDirectory, asset.contentFile), "utf8")
          : undefined;
        const map = asset.mapFile
          ? (JSON.parse(
              await readFile(join(input.stageDirectory, asset.mapFile), "utf8"),
            ) as RawSourceMapPayload)
          : undefined;
        return {
          ...(generated === undefined ? {} : { generated }),
          ...(map === undefined ? {} : { map }),
        };
      },
    });
    onProgress?.("Finalizing source details", 0, 1);
    await detailWriter.finish(temporaryDetailsIndex);
    await rename(temporaryDetails, input.detailsFile);
    await rename(temporaryDetailsIndex, input.detailsIndexFile);
    onProgress?.("Finalizing source details", 1, 1);
  } catch (error) {
    await detailWriter.abort();
    await Promise.all([
      rm(temporaryDetails, { force: true }),
      rm(temporaryDetailsIndex, { force: true }),
      rm(input.detailsFile, { force: true }),
      rm(input.detailsIndexFile, { force: true }),
    ]);
    throw error;
  }

  const complete: CoverageAnalysisStatus = {
    status: "complete",
    id: input.id,
    recentAvailable: true,
    report,
  };
  const temporaryReport = `${input.reportFile}.tmp`;
  onProgress?.("Serializing report", 0, 1);
  const serialized = JSON.stringify(complete);
  onProgress?.("Serializing report", 1, 1);
  onProgress?.("Writing report", 0, 1);
  await writeFile(temporaryReport, serialized);
  await rename(temporaryReport, input.reportFile);
  onProgress?.("Writing report", 1, 1);
}

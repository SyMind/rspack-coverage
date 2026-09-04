import { type FileHandle, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  analyzeCoverage,
  matchCoverage,
  type StoredSourceFileDetail,
} from "../analyzer/analyze.js";
import { assertSnapshotRecordSize, MAX_COVERAGE_ANALYSIS_BYTES } from "../shared/snapshotLimits.js";
import type {
  BuildManifest,
  ChromeCoverageEntry,
  ChromeCoverageRange,
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
  /** SQLite payload store from a persisted v2 build snapshot. */
  sourceDatabaseFile?: string;
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

export interface CoverageRangeIndexWorkerData {
  kind: "coverage-range-index";
  build: Pick<BuildManifest, "hash" | "assets">;
  recordingFile: string;
}

export type CoverageRangeIndex = Array<[assetId: string, ranges: ChromeCoverageRange[]]>;

export async function loadCoverageRangeIndex(
  input: CoverageRangeIndexWorkerData,
): Promise<CoverageRangeIndex> {
  if ((await stat(input.recordingFile)).size > MAX_COVERAGE_ANALYSIS_BYTES) {
    throw new Error("Coverage JSON exceeds the 128 MiB in-memory analysis guard.");
  }
  const coverage = JSON.parse(await readFile(input.recordingFile, "utf8")) as unknown;
  if (!Array.isArray(coverage)) throw new Error("Chrome Coverage JSON must contain an array.");
  const { matched } = await matchCoverage(input.build, coverage as ChromeCoverageEntry[]);
  return [...matched].map(([assetId, entry]) => [assetId, entry.ranges]);
}

function stagedFile(directory: string, value: string): string {
  if (!value || isAbsolute(value)) throw new Error(`Invalid staged snapshot path: ${value}`);
  const file = resolve(directory, value);
  const relativeFile = relative(directory, file);
  if (
    !relativeFile ||
    relativeFile === ".." ||
    relativeFile.startsWith(`..${sep}`) ||
    isAbsolute(relativeFile)
  ) {
    throw new Error(`Staged snapshot path escapes its directory: ${value}`);
  }
  return file;
}

export async function runCoverageAnalysisJob(
  input: CoverageAnalysisWorkerData,
  onProgress?: (phase: string, completed: number, total: number) => void,
): Promise<void> {
  onProgress?.("Reading build snapshot", 0, 1);
  const staged = JSON.parse(
    await readFile(join(input.stageDirectory, "snapshot.json"), "utf8"),
  ) as StagedCoverageSnapshot;
  if ((await stat(input.recordingFile)).size > MAX_COVERAGE_ANALYSIS_BYTES) {
    throw new Error("Coverage JSON exceeds the 128 MiB in-memory analysis guard.");
  }
  const coverage = JSON.parse(await readFile(input.recordingFile, "utf8")) as unknown;
  if (!Array.isArray(coverage)) throw new Error("Chrome Coverage JSON must contain an array.");

  const temporaryDetails = `${input.detailsFile}.tmp`;
  const temporaryDetailsIndex = `${input.detailsIndexFile}.tmp`;
  const discoveredSourcesFile = `${temporaryDetails}.sources.sqlite`;
  await Promise.all([
    rm(temporaryDetails, { force: true }),
    rm(temporaryDetailsIndex, { force: true }),
    rm(discoveredSourcesFile, { force: true }),
  ]);
  const stagedSources = new Map(
    staged.sources.map((source) => [source.path, source.contentFile] as const),
  );
  const sourceDatabase = staged.sourceDatabaseFile
    ? new DatabaseSync(stagedFile(input.stageDirectory, staged.sourceDatabaseFile), {
        readOnly: true,
      })
    : null;
  sourceDatabase?.exec(`
    PRAGMA query_only = ON;
    PRAGMA temp_store = FILE;
    PRAGMA cache_size = -32768;
    PRAGMA mmap_size = 0;
  `);
  const storedSource = sourceDatabase?.prepare("SELECT payload FROM sources WHERE key = ?");
  const storedSourceKeys = sourceDatabase?.prepare("SELECT key FROM sources ORDER BY key");
  let discoveredDatabase: DatabaseSync | null = null;
  let discoveredSource: StatementSync | null = null;
  let insertDiscoveredSource: StatementSync | null = null;
  const ensureDiscoveredDatabase = () => {
    if (discoveredDatabase) return;
    discoveredDatabase = new DatabaseSync(discoveredSourcesFile);
    discoveredDatabase.exec(`
      PRAGMA journal_mode = OFF;
      PRAGMA synchronous = OFF;
      PRAGMA temp_store = FILE;
      PRAGMA cache_size = -8192;
      PRAGMA mmap_size = 0;
      CREATE TABLE sources (
        key TEXT PRIMARY KEY,
        payload BLOB NOT NULL
      ) WITHOUT ROWID;
    `);
    discoveredSource = discoveredDatabase.prepare("SELECT payload FROM sources WHERE key = ?");
    insertDiscoveredSource = discoveredDatabase.prepare(
      "INSERT OR IGNORE INTO sources (key, payload) VALUES (?, ?)",
    );
  };
  const closeDiscoveredDatabase = () => {
    discoveredDatabase?.close();
    discoveredDatabase = null;
  };
  const originalSourcePaths: Iterable<string> = {
    *[Symbol.iterator]() {
      yield* stagedSources.keys();
      if (storedSourceKeys) {
        for (const row of storedSourceKeys.iterate()) yield String(row.key);
      }
    },
  };
  const loadOriginalSource = async (sourceKey: string): Promise<string | null> => {
    const sourceFile = stagedSources.get(sourceKey);
    if (sourceFile) {
      return readFile(stagedFile(input.stageDirectory, sourceFile), "utf8");
    }
    const stored = storedSource?.get(sourceKey)?.payload;
    if (stored instanceof Uint8Array) return Buffer.from(stored).toString("utf8");
    const discovered = discoveredSource?.get(sourceKey)?.payload;
    return discovered instanceof Uint8Array ? Buffer.from(discovered).toString("utf8") : null;
  };
  const detailWriter = await CoverageFileDetailWriter.create(temporaryDetails);
  let report: CoverageReport;
  try {
    report = await analyzeCoverage({
      build: staged.build,
      coverage: coverage as ChromeCoverageEntry[],
      originalSourcePaths,
      loadOriginalSource,
      storeDiscoveredSource: async (sourceKey, content) => {
        ensureDiscoveredDatabase();
        assertSnapshotRecordSize("source-map source", sourceKey, Buffer.byteLength(content));
        insertDiscoveredSource?.run(sourceKey, Buffer.from(content));
      },
      precision: input.precision,
      ...(onProgress ? { onProgress } : {}),
      onFileDetail: (file) => detailWriter.write(file),
      loadAsset: async (assetId, needsGeneratedSource) => {
        const asset = staged.assets[assetId];
        if (!asset) return {};
        const generated = needsGeneratedSource
          ? await readFile(stagedFile(input.stageDirectory, asset.contentFile), "utf8")
          : undefined;
        const map = asset.mapFile
          ? (JSON.parse(
              await readFile(stagedFile(input.stageDirectory, asset.mapFile), "utf8"),
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
  } finally {
    sourceDatabase?.close();
    closeDiscoveredDatabase();
    await rm(discoveredSourcesFile, { force: true });
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

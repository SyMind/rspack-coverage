import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { materializeSourceFileDetail, type StoredSourceFileDetail } from "../analyzer/analyze.js";
import { MAX_COVERAGE_ANALYSIS_BYTES } from "../shared/snapshotLimits.js";
import type {
  BuildSnapshot,
  CoverageAnalysisStatus,
  CoverageImportSummary,
  SourceFileDetail,
} from "../shared/types.js";
import {
  type CoverageAnalysisWorkerData,
  type CoverageFileDetailIndex,
  runCoverageAnalysisJob,
  type StagedCoverageSnapshot,
} from "./coverageAnalysisRunner.js";

interface StagedBuild {
  hash: string;
  identity: string;
  generation: number;
  directory: Promise<string>;
  recordingFile: string | null;
  persistent: boolean;
}

interface AnalysisJob {
  id: string;
  generation: number;
  status:
    | Extract<CoverageAnalysisStatus, { status: "pending" | "error" }>
    | { status: "complete"; id: string; recentAvailable: true };
  reportFile: string;
  detailsFile: string;
  detailsIndexFile: string;
  detailsIndex?: Promise<CoverageFileDetailIndex>;
  persistent: boolean;
}

type WorkerMessage =
  | { type: "progress"; id: string; phase: string; completed: number; total: number }
  | { type: "complete"; id: string }
  | { type: "error"; id: string; message: string };

export type CoverageAnalysisView =
  | CoverageAnalysisStatus
  | { status: "complete-file"; reportFile: string };

export class CoverageUploadTooLargeError extends Error {}
export class CoverageBuildChangedError extends Error {}
export class MissingCoverageRecordingError extends Error {}
export class CoverageReportNotReadyError extends Error {}
export class MissingCoverageSourceError extends Error {}

async function readRange(file: string, offset: number, length: number): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const result = await handle.read(buffer, read, length - read, offset + read);
      if (result.bytesRead === 0) throw new Error("Coverage source details ended unexpectedly.");
      read += result.bytesRead;
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

function precision(value: string | null): CoverageImportSummary["precision"] {
  if (value === "per-block" || value === "per-function" || value === "unknown") return value;
  throw new TypeError("precision must be per-block, per-function, or unknown");
}

export function parseCoveragePrecision(value: string | null): CoverageImportSummary["precision"] {
  return precision(value);
}

async function stageSnapshot(snapshot: BuildSnapshot): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "rspack-coverage-analysis-"));
  const assetsDirectory = join(directory, "assets");
  const mapsDirectory = join(directory, "maps");
  const sourcesDirectory = join(directory, "sources");
  try {
    await Promise.all([
      mkdir(assetsDirectory, { recursive: true }),
      mkdir(mapsDirectory, { recursive: true }),
      mkdir(sourcesDirectory, { recursive: true }),
    ]);
    const staged: StagedCoverageSnapshot = { build: snapshot.manifest, assets: {}, sources: [] };

    for (let index = 0; index < snapshot.manifest.assets.length; index += 1) {
      const asset = snapshot.manifest.assets[index];
      if (!asset) continue;
      const content = snapshot.assets.get(asset.id);
      if (!content) continue;
      const contentFile = `assets/${index}.js`;
      await writeFile(join(directory, contentFile), content);
      const sourceMapPayload = snapshot.mapPayloads?.get(asset.id);
      const sourceMap = sourceMapPayload ? undefined : snapshot.maps.get(asset.id);
      const mapFile = sourceMapPayload || sourceMap ? `maps/${index}.json` : null;
      if (mapFile) {
        await writeFile(join(directory, mapFile), sourceMapPayload ?? JSON.stringify(sourceMap));
      }
      staged.assets[asset.id] = { contentFile, mapFile };
    }

    let sourceIndex = 0;
    for (const [path, content] of snapshot.originalSources) {
      const contentFile = `sources/${sourceIndex}.txt`;
      sourceIndex += 1;
      await writeFile(join(directory, contentFile), content);
      staged.sources.push({ path, contentFile });
    }
    await writeFile(join(directory, "snapshot.json"), JSON.stringify(staged));
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function storeUpload(body: Readable, destination: string): Promise<void> {
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      if (bytes > MAX_COVERAGE_ANALYSIS_BYTES) {
        callback(
          new CoverageUploadTooLargeError(
            "Coverage JSON exceeds the 128 MiB in-memory analysis guard.",
          ),
        );
      } else {
        callback(null, chunk);
      }
    },
  });
  try {
    await pipeline(body, limiter, createWriteStream(destination, { flags: "wx" }));
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
}

export class CoverageAnalysisService {
  #generation = 0;
  #build: StagedBuild | null = null;
  #job: AnalysisJob | null = null;
  #worker: Worker | null = null;

  update(snapshot: BuildSnapshot, force = false): void {
    const identity =
      snapshot.storage?.snapshotId ??
      `memory:${snapshot.manifest.hash}:${snapshot.manifest.builtAt}`;
    if (!force && this.#build?.identity === identity) return;
    const previous = this.#build;
    this.#generation += 1;
    this.#cancelWorker();
    this.#job = null;
    const persistentDirectory = snapshot.storage?.directory ?? null;
    const persistent = persistentDirectory !== null;
    const directory = persistentDirectory
      ? Promise.resolve(persistentDirectory)
      : stageSnapshot(snapshot);
    void directory.catch(() => undefined);
    const recordingFile = persistentDirectory ? join(persistentDirectory, "coverage.json") : null;
    this.#build = {
      hash: snapshot.manifest.hash,
      identity,
      generation: this.#generation,
      directory,
      recordingFile: recordingFile && existsSync(recordingFile) ? recordingFile : null,
      persistent,
    };
    if (persistentDirectory) {
      const reportFile = join(persistentDirectory, "report.json");
      const detailsFile = join(persistentDirectory, "report.sources");
      const detailsIndexFile = join(persistentDirectory, "report.sources.index.json");
      if (existsSync(reportFile) && existsSync(detailsFile) && existsSync(detailsIndexFile)) {
        this.#job = {
          id: "restored",
          generation: this.#generation,
          status: { status: "complete", id: "restored", recentAvailable: true },
          reportFile,
          detailsFile,
          detailsIndexFile,
          persistent: true,
        };
      }
    }
    if (previous && !previous.persistent) {
      void previous.directory
        .then((path) => rm(path, { recursive: true, force: true }))
        .catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    const worker = this.#worker;
    this.#worker = null;
    if (worker) await worker.terminate();
    const build = this.#build;
    this.#build = null;
    if (build && !build.persistent) {
      await build.directory
        .then((path) => rm(path, { recursive: true, force: true }))
        .catch(() => undefined);
    }
  }

  async submit(
    buildHash: string,
    body: Readable,
    analysisPrecision: CoverageImportSummary["precision"],
  ): Promise<CoverageAnalysisStatus> {
    const build = this.#requireBuild(buildHash);
    const directory = await build.directory;
    const temporaryFile = join(directory, `coverage-${randomUUID()}.upload`);
    await storeUpload(body, temporaryFile);
    if (build !== this.#build || build.generation !== this.#generation) {
      await rm(temporaryFile, { force: true });
      throw new CoverageBuildChangedError("The build changed while Coverage was uploading.");
    }
    this.#cancelWorker();
    const recordingFile = join(directory, "coverage.json");
    await rm(recordingFile, { force: true });
    await rename(temporaryFile, recordingFile);
    build.recordingFile = recordingFile;
    return this.#start(build, analysisPrecision);
  }

  async reuse(
    buildHash: string,
    analysisPrecision: CoverageImportSummary["precision"],
  ): Promise<CoverageAnalysisStatus> {
    const build = this.#requireBuild(buildHash);
    await build.directory;
    if (!build.recordingFile || !existsSync(build.recordingFile)) {
      throw new MissingCoverageRecordingError(
        "No recent Coverage recording exists for this build.",
      );
    }
    this.#cancelWorker();
    return this.#start(build, analysisPrecision);
  }

  view(buildHash: string): CoverageAnalysisView {
    const build = this.#requireBuild(buildHash);
    const recentAvailable = Boolean(build.recordingFile && existsSync(build.recordingFile));
    const job = this.#job;
    if (!job || job.generation !== build.generation) {
      return { status: "idle", recentAvailable };
    }
    if (job.status.status === "pending") return { ...job.status, recentAvailable };
    if (job.status.status === "error") return { ...job.status, recentAvailable };
    return { status: "complete-file", reportFile: job.reportFile };
  }

  async source(
    buildHash: string,
    fileId: string,
    moduleId?: string | null,
  ): Promise<SourceFileDetail> {
    const build = this.#requireBuild(buildHash);
    const job = this.#job;
    if (!job || job.generation !== build.generation || job.status.status !== "complete") {
      throw new CoverageReportNotReadyError("Coverage analysis has not completed yet.");
    }
    if (!existsSync(job.detailsFile) || !existsSync(job.detailsIndexFile)) {
      throw new CoverageReportNotReadyError("Coverage source details are unavailable.");
    }
    job.detailsIndex ??= readFile(job.detailsIndexFile, "utf8").then(
      (content) => JSON.parse(content) as CoverageFileDetailIndex,
    );
    const index = await job.detailsIndex;
    if (index.version !== 1 || !index.entries || typeof index.entries !== "object") {
      throw new CoverageReportNotReadyError("Coverage source details index is invalid.");
    }
    const location = Object.hasOwn(index.entries, fileId) ? index.entries[fileId] : undefined;
    if (
      !location ||
      !Number.isSafeInteger(location.offset) ||
      location.offset < 0 ||
      !Number.isSafeInteger(location.length) ||
      location.length <= 0
    ) {
      throw new MissingCoverageSourceError(`Coverage source detail not found for ${fileId}.`);
    }
    const stored = JSON.parse(
      (await readRange(job.detailsFile, location.offset, location.length)).toString("utf8"),
    ) as StoredSourceFileDetail;
    if (stored.id !== fileId) {
      throw new CoverageReportNotReadyError("Coverage source details index is invalid.");
    }
    return materializeSourceFileDetail(stored, moduleId);
  }

  #requireBuild(buildHash: string): StagedBuild {
    const build = this.#build;
    if (!build || build.hash !== buildHash) {
      throw new CoverageBuildChangedError(
        "The build changed. Refresh the report and import Coverage for the latest build.",
      );
    }
    return build;
  }

  #start(
    build: StagedBuild,
    analysisPrecision: CoverageImportSummary["precision"],
  ): CoverageAnalysisStatus {
    if (!build.recordingFile)
      throw new MissingCoverageRecordingError("Coverage recording missing.");
    const id = randomUUID();
    const reportFile = build.persistent
      ? join(resolve(dirname(build.recordingFile)), "report.json")
      : join(resolve(dirname(build.recordingFile)), `report-${id}.json`);
    const detailsFile = build.persistent
      ? join(resolve(dirname(build.recordingFile)), "report.sources")
      : `${reportFile}.sources`;
    const detailsIndexFile = build.persistent
      ? join(resolve(dirname(build.recordingFile)), "report.sources.index.json")
      : `${detailsFile}.index.json`;
    const status: AnalysisJob["status"] = {
      status: "pending",
      id,
      phase: "Queued in Node",
      completed: 0,
      total: 1,
      recentAvailable: true,
    };
    const previousJob = this.#job;
    const job: AnalysisJob = {
      id,
      generation: build.generation,
      status,
      reportFile,
      detailsFile,
      detailsIndexFile,
      persistent: build.persistent,
    };
    this.#job = job;
    if (previousJob && !previousJob.persistent) void this.#removeArtifacts(previousJob);
    void build.directory
      .then((stageDirectory) => {
        if (this.#job !== job) return;
        const input: CoverageAnalysisWorkerData = {
          id,
          stageDirectory,
          recordingFile: build.recordingFile as string,
          reportFile,
          detailsFile,
          detailsIndexFile,
          precision: analysisPrecision,
        };
        this.#launch(job, input);
      })
      .catch((error) => this.#fail(job, error));
    return status;
  }

  #launch(job: AnalysisJob, input: CoverageAnalysisWorkerData): void {
    const currentFile = fileURLToPath(import.meta.url);
    const extension = extname(currentFile) === ".cjs" ? ".cjs" : ".js";
    const workerFile = resolve(dirname(currentFile), `coverage-analysis-worker${extension}`);
    if (!existsSync(workerFile)) {
      setImmediate(() => {
        void runCoverageAnalysisJob(input, (phase, completed, total) => {
          this.#progress(job, phase, completed, total);
        })
          .then(() => this.#complete(job))
          .catch((error) => this.#fail(job, error));
      });
      return;
    }

    const worker = new Worker(workerFile, {
      workerData: input,
      execArgv: process.execArgv.filter((argument) => !argument.startsWith("--input-type")),
    });
    this.#worker = worker;
    worker.on("message", (message: WorkerMessage) => {
      if (message.type === "progress") {
        this.#progress(job, message.phase, message.completed, message.total);
      } else if (message.type === "complete") {
        this.#complete(job);
      } else {
        this.#fail(job, new Error(message.message));
      }
    });
    worker.on("error", (error) => this.#fail(job, error));
    worker.on("exit", (code) => {
      if (code !== 0 && job.status.status === "pending") {
        this.#fail(job, new Error(`Coverage analysis worker exited with code ${code}.`));
      }
      if (this.#worker === worker) this.#worker = null;
    });
  }

  #progress(job: AnalysisJob, phase: string, completed: number, total: number): void {
    if (this.#job !== job || job.generation !== this.#generation) return;
    job.status = {
      status: "pending",
      id: job.id,
      phase,
      completed,
      total,
      recentAvailable: true,
    };
  }

  #complete(job: AnalysisJob): void {
    if (this.#job !== job || job.generation !== this.#generation) return;
    job.status = {
      status: "complete",
      id: job.id,
      recentAvailable: true,
    };
  }

  #fail(job: AnalysisJob, error: unknown): void {
    if (this.#job !== job || job.generation !== this.#generation) return;
    job.status = {
      status: "error",
      id: job.id,
      recentAvailable: Boolean(this.#build?.recordingFile),
      message: error instanceof Error ? error.message : String(error),
    };
    void this.#removeArtifacts(job, !job.persistent);
  }

  async #removeArtifacts(job: AnalysisJob, includeFinal = true): Promise<void> {
    const files = includeFinal ? [job.reportFile, job.detailsFile, job.detailsIndexFile] : [];
    await Promise.all(
      [job.reportFile, job.detailsFile, job.detailsIndexFile]
        .flatMap((file) => [rm(`${file}.tmp`, { force: true })])
        .concat(files.map((file) => rm(file, { force: true }))),
    );
  }

  #cancelWorker(): void {
    const worker = this.#worker;
    this.#worker = null;
    if (worker) void worker.terminate();
  }
}

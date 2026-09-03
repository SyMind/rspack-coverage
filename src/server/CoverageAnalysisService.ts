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
import { intersectRanges } from "../analyzer/ranges.js";
import { buildGeneratedSpans } from "../analyzer/sourceMap.js";
import { MAX_COVERAGE_ANALYSIS_BYTES } from "../shared/snapshotLimits.js";
import type {
  BuildSnapshot,
  ChromeCoverageRange,
  CodeCoverageSpan,
  CodeViewResponse,
  CoverageAnalysisStatus,
  CoverageImportSummary,
  RawSourceMapPayload,
  SourceFileDetail,
} from "../shared/types.js";
import {
  type CoverageAnalysisWorkerData,
  type CoverageFileDetailIndex,
  type CoverageRangeIndex,
  type CoverageRangeIndexWorkerData,
  loadCoverageRangeIndex,
  runCoverageAnalysisJob,
  type StagedCoverageSnapshot,
} from "./coverageAnalysisRunner.js";

interface CoverageEvidence {
  available: boolean;
  ranges: Map<string, ChromeCoverageRange[]>;
}

interface StagedBuild {
  hash: string;
  identity: string;
  generation: number;
  directory: Promise<string>;
  recordingFile: string | null;
  persistent: boolean;
  assets: ReadonlyMap<string, Buffer>;
  maps: ReadonlyMap<string, RawSourceMapPayload>;
  manifest: Pick<BuildSnapshot["manifest"], "hash" | "assets">;
  coverageEvidence: Promise<CoverageEvidence> | undefined;
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

type CoverageRangeWorkerMessage =
  | { type: "coverage-range-index-complete"; ranges: CoverageRangeIndex }
  | { type: "error"; id: string; message: string };

export type CoverageAnalysisView =
  | CoverageAnalysisStatus
  | { status: "complete-file"; reportFile: string };

export class CoverageUploadTooLargeError extends Error {}
export class CoverageBuildChangedError extends Error {}
export class MissingCoverageRecordingError extends Error {}
export class CoverageReportNotReadyError extends Error {}
export class MissingCoverageSourceError extends Error {}

const MAX_SOURCE_DETAIL_ALIASES = 16;
const UNMAPPED_SOURCE_PREFIX = "[rspack runtime / unmapped]/";
const DEFAULT_GENERATED_SOURCE_LIMIT = 240_000;
const MAX_GENERATED_SOURCE_LIMIT = 500_000;

function sourceIdsMayAlias(left: string, right: string): boolean {
  const normalizedLeft = left.replace(/\\/g, "/").replace(/^\/+/, "");
  const normalizedRight = right.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalizedLeft === normalizedRight) return true;
  const shorter = normalizedLeft.length < normalizedRight.length ? normalizedLeft : normalizedRight;
  const longer = shorter === normalizedLeft ? normalizedRight : normalizedLeft;
  return shorter.includes("/") && longer.endsWith(`/${shorter}`);
}

function storedSourceLineEvidenceScore(
  detail: StoredSourceFileDetail,
  lineNumber: number,
  moduleId?: string | null,
): number {
  const line = detail.mappedLines.find((candidate) => candidate.lineIndex === lineNumber - 1);
  if (!line) return 0;
  if (line.emittedBytes <= 0) return 0;
  if (moduleId && line.moduleStates && !Object.hasOwn(line.moduleStates, moduleId)) return 0;
  const evidence = moduleId ? line.moduleStates?.[moduleId] : undefined;
  const loadedBytes = evidence?.loadedBytes ?? line.loadedBytes;
  const executedBytes = evidence?.executedBytes ?? line.executedBytes;
  if (executedBytes > 0) return 5;
  return loadedBytes > 0 ? 4 : 3;
}

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

function mergeCodeSpans(spans: CodeCoverageSpan[]): CodeCoverageSpan[] {
  const sorted = spans
    .filter((span) => span.end > span.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: CodeCoverageSpan[] = [];
  for (const span of sorted) {
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end && previous.status === span.status) {
      previous.end = Math.max(previous.end, span.end);
    } else if (previous && span.start < previous.end) {
      if (span.end > previous.end) merged.push({ ...span, start: previous.end });
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function coverageParts(
  start: number,
  end: number,
  ranges: ChromeCoverageRange[] | undefined,
  recordingAvailable: boolean,
): CodeCoverageSpan[] {
  if (!recordingAvailable) return [{ start, end, status: "unknown" }];
  if (!ranges) return [{ start, end, status: "unloaded" }];
  const executed = intersectRanges(ranges, start, end);
  const result: CodeCoverageSpan[] = [];
  let cursor = start;
  for (const range of executed) {
    if (range.start > cursor) {
      result.push({ start: cursor, end: range.start, status: "unexecuted" });
    }
    if (range.end > range.start) {
      result.push({ start: range.start, end: range.end, status: "executed" });
    }
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < end) result.push({ start: cursor, end, status: "unexecuted" });
  return result;
}

function sliceGeneratedCode(
  response: Omit<
    CodeViewResponse,
    "offset" | "endOffset" | "startLine" | "totalCharacters" | "hasPrevious" | "hasNext"
  >,
  requestedOffset: number,
  requestedLimit: number,
): CodeViewResponse {
  const totalCharacters = response.content.length;
  const offset = Math.max(0, Math.min(totalCharacters, Math.trunc(requestedOffset || 0)));
  const limit = Math.max(
    1,
    Math.min(
      MAX_GENERATED_SOURCE_LIMIT,
      Math.trunc(requestedLimit || DEFAULT_GENERATED_SOURCE_LIMIT),
    ),
  );
  const endOffset = Math.min(totalCharacters, offset + limit);
  return {
    ...response,
    content: response.content.slice(offset, endOffset),
    spans: response.spans
      .filter((span) => span.end > offset && span.start < endOffset)
      .map((span) => ({
        ...span,
        start: Math.max(0, span.start - offset),
        end: Math.min(endOffset, span.end) - offset,
      })),
    offset,
    endOffset,
    startLine: response.content.slice(0, offset).split("\n").length,
    totalCharacters,
    hasPrevious: offset > 0,
    hasNext: endOffset < totalCharacters,
  };
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
  #rangeWorker: Worker | null = null;

  update(snapshot: BuildSnapshot, force = false): void {
    const identity =
      snapshot.storage?.snapshotId ??
      `memory:${snapshot.manifest.hash}:${snapshot.manifest.builtAt}`;
    if (!force && this.#build?.identity === identity) return;
    const previous = this.#build;
    this.#generation += 1;
    this.#cancelWorker();
    this.#cancelRangeWorker();
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
      assets: snapshot.assets,
      maps: snapshot.maps,
      manifest: { hash: snapshot.manifest.hash, assets: snapshot.manifest.assets },
      coverageEvidence: undefined,
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
    const rangeWorker = this.#rangeWorker;
    this.#rangeWorker = null;
    if (rangeWorker) await rangeWorker.terminate();
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
    build.coverageEvidence = undefined;
    this.#cancelRangeWorker();
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
    preferredLine?: number | null,
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
    const readStored = async (id: string): Promise<StoredSourceFileDetail | null> => {
      const location = Object.hasOwn(index.entries, id) ? index.entries[id] : undefined;
      if (!location) return null;
      if (
        !Number.isSafeInteger(location.offset) ||
        location.offset < 0 ||
        !Number.isSafeInteger(location.length) ||
        location.length <= 0
      ) {
        throw new CoverageReportNotReadyError("Coverage source details index is invalid.");
      }
      const stored = JSON.parse(
        (await readRange(job.detailsFile, location.offset, location.length)).toString("utf8"),
      ) as StoredSourceFileDetail;
      if (stored.id !== id) {
        throw new CoverageReportNotReadyError("Coverage source details index is invalid.");
      }
      return stored;
    };

    const stored = await readStored(fileId);
    if (!stored) {
      throw new MissingCoverageSourceError(`Coverage source detail not found for ${fileId}.`);
    }
    const lineNumber =
      preferredLine && Number.isSafeInteger(preferredLine) && preferredLine > 0
        ? preferredLine
        : null;
    if (
      lineNumber === null ||
      stored.content === null ||
      storedSourceLineEvidenceScore(stored, lineNumber, moduleId) >= 3
    ) {
      return materializeSourceFileDetail(stored, moduleId);
    }

    let selected = stored;
    let selectedScore = storedSourceLineEvidenceScore(stored, lineNumber, moduleId);
    const aliases: string[] = [];
    for (const candidate in index.entries) {
      if (candidate === fileId || !sourceIdsMayAlias(candidate, fileId)) continue;
      aliases.push(candidate);
      aliases.sort((left, right) => left.length - right.length);
      if (aliases.length > MAX_SOURCE_DETAIL_ALIASES) aliases.pop();
    }
    for (const alias of aliases) {
      const candidate = await readStored(alias);
      if (!candidate || candidate.content !== stored.content) continue;
      const score = storedSourceLineEvidenceScore(candidate, lineNumber, moduleId);
      if (score <= selectedScore) continue;
      selected = candidate;
      selectedScore = score;
      if (score === 5) break;
    }
    return materializeSourceFileDetail(selected, moduleId);
  }

  async generatedSource(
    buildHash: string,
    fileId: string,
    offset = 0,
    limit = DEFAULT_GENERATED_SOURCE_LIMIT,
  ): Promise<CodeViewResponse> {
    const build = this.#requireBuild(buildHash);
    const job = this.#job;
    if (!job || job.generation !== build.generation || job.status.status !== "complete") {
      throw new CoverageReportNotReadyError("Coverage analysis has not completed yet.");
    }
    if (!fileId.startsWith(UNMAPPED_SOURCE_PREFIX)) {
      throw new MissingCoverageSourceError(
        `Generated output fallback is unavailable for ${fileId}.`,
      );
    }
    const assetName = fileId.slice(UNMAPPED_SOURCE_PREFIX.length);
    const matchingAssets = build.manifest.assets.filter((asset) => asset.name === assetName);
    if (matchingAssets.length !== 1) {
      throw new MissingCoverageSourceError(
        matchingAssets.length === 0
          ? `Generated asset not found for ${fileId}.`
          : `Generated asset is ambiguous for ${fileId}.`,
      );
    }
    const asset = matchingAssets[0];
    if (!asset) throw new MissingCoverageSourceError(`Generated asset not found for ${fileId}.`);
    const generated = build.assets.get(asset.id)?.toString("utf8");
    if (generated === undefined) {
      throw new MissingCoverageSourceError(`Generated content is unavailable for ${asset.name}.`);
    }
    const evidence = await this.#coverageEvidence(build);
    if (build !== this.#build || build.generation !== this.#generation) {
      throw new CoverageBuildChangedError("The build changed while generated output was loading.");
    }
    const sourceMap = build.maps.get(asset.id);
    const generatedSpans = sourceMap
      ? buildGeneratedSpans(generated, sourceMap)
      : [
          {
            start: 0,
            end: generated.length,
            source: null,
            sourceContent: null,
            originalLine: null,
            originalColumn: null,
            originalEndColumn: null,
          },
        ];
    const runtimeSpans = generatedSpans.flatMap((span) =>
      span.source === null
        ? coverageParts(span.start, span.end, evidence.ranges.get(asset.id), evidence.available)
        : [],
    );
    const coverageGap = evidence.available
      ? "Only generated bytes without stable source-map attribution are colored. Mapped source bytes remain neutral context; the metrics above describe only this unmapped bucket."
      : "The original Coverage recording is unavailable. Unmapped generated bytes are marked unknown, while mapped source bytes remain neutral context.";
    return sliceGeneratedCode(
      {
        view: "output",
        sourceId: fileId,
        filename: asset.name,
        language: "javascript",
        content: generated,
        spans: mergeCodeSpans(runtimeSpans),
        provenance: "final generated asset / unmapped fallback",
        gap: coverageGap,
      },
      offset,
      limit,
    );
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

  #coverageEvidence(build: StagedBuild): Promise<CoverageEvidence> {
    if (build.coverageEvidence) return build.coverageEvidence;
    const pending = this.#loadCoverageEvidence(build);
    build.coverageEvidence = pending;
    void pending.catch(() => {
      if (build.coverageEvidence === pending) build.coverageEvidence = undefined;
    });
    return pending;
  }

  async #loadCoverageEvidence(build: StagedBuild): Promise<CoverageEvidence> {
    if (!build.recordingFile || !existsSync(build.recordingFile)) {
      return { available: false, ranges: new Map() };
    }
    const input: CoverageRangeIndexWorkerData = {
      kind: "coverage-range-index",
      build: build.manifest,
      recordingFile: build.recordingFile,
    };
    const currentFile = fileURLToPath(import.meta.url);
    const extension = extname(currentFile) === ".cjs" ? ".cjs" : ".js";
    const workerFile = resolve(dirname(currentFile), `coverage-analysis-worker${extension}`);
    const ranges = existsSync(workerFile)
      ? await this.#loadCoverageRangeIndexInWorker(workerFile, input)
      : await loadCoverageRangeIndex(input);
    return { available: true, ranges: new Map(ranges) };
  }

  #loadCoverageRangeIndexInWorker(
    workerFile: string,
    input: CoverageRangeIndexWorkerData,
  ): Promise<CoverageRangeIndex> {
    this.#cancelRangeWorker();
    return new Promise((resolvePromise, reject) => {
      const worker = new Worker(workerFile, {
        workerData: input,
        execArgv: process.execArgv.filter((argument) => !argument.startsWith("--input-type")),
      });
      this.#rangeWorker = worker;
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (this.#rangeWorker === worker) this.#rangeWorker = null;
        callback();
      };
      worker.on("message", (message: CoverageRangeWorkerMessage) => {
        if (message.type === "coverage-range-index-complete") {
          finish(() => resolvePromise(message.ranges));
        } else {
          finish(() => reject(new Error(message.message)));
        }
      });
      worker.on("error", (error) => finish(() => reject(error)));
      worker.on("exit", (code) => {
        if (!settled) {
          finish(() =>
            reject(new Error(`Coverage range worker exited before completion with code ${code}.`)),
          );
        }
      });
    });
  }

  #cancelRangeWorker(): void {
    const worker = this.#rangeWorker;
    this.#rangeWorker = null;
    if (worker) void worker.terminate();
  }
}

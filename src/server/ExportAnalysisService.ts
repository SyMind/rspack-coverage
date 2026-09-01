import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { normalizeSourcePathForContext } from "../shared/path.js";
import type {
  BuildSnapshot,
  ExportAnalysisInput,
  SourceExportAnalysisStatus,
  SourceExportUsageReport,
} from "../shared/types.js";
import { analyzeSourceExports } from "./exportAnalysis.js";

interface Job {
  id: string;
  key: string;
  generation: number;
  status: SourceExportAnalysisStatus;
}

type WorkerMessage =
  | { type: "progress"; id: string; phase: string; completed: number; total: number }
  | { type: "complete"; id: string; report: SourceExportUsageReport }
  | { type: "error"; id: string; message: string };

function sourceKey(snapshot: BuildSnapshot, requested: string): string | null {
  const normalized = normalizeSourcePathForContext(requested, snapshot.manifest.context);
  if (snapshot.originalSources.has(normalized)) return normalized;
  const matches = [...snapshot.originalSources.keys()].filter(
    (source) => source.endsWith(`/${normalized}`) || normalized.endsWith(`/${source}`),
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function matchesSource(snapshot: BuildSnapshot, candidate: string, source: string): boolean {
  const normalized = normalizeSourcePathForContext(candidate, snapshot.manifest.context);
  return (
    normalized === source || normalized.endsWith(`/${source}`) || source.endsWith(`/${normalized}`)
  );
}

function prepareInput(snapshot: BuildSnapshot, requested: string): ExportAnalysisInput {
  const source =
    sourceKey(snapshot, requested) ??
    normalizeSourcePathForContext(requested, snapshot.manifest.context);
  let content = snapshot.originalSources.get(source) ?? "";
  const directIds = snapshot.exportGraph.sourceToModuleIds[source] ?? [];
  const moduleIds = new Set(directIds);
  if (moduleIds.size === 0) {
    for (const [candidate, ids] of Object.entries(snapshot.exportGraph.sourceToModuleIds)) {
      if (candidate.endsWith(`/${source}`) || source.endsWith(`/${candidate}`)) {
        for (const id of ids) moduleIds.add(id);
      }
    }
  }
  for (const module of snapshot.manifest.modules) {
    if (
      (module.resource && matchesSource(snapshot, module.resource, source)) ||
      module.sourcePaths?.some((path) => matchesSource(snapshot, path, source))
    ) {
      moduleIds.add(module.id);
      if (!content && module.resource && existsSync(module.resource)) {
        content = readFileSync(module.resource, "utf8");
      }
    }
  }
  const graphModulesById = new Map(
    snapshot.exportGraph.modules.map((module) => [module.id, module]),
  );
  const modulesById = new Map(
    snapshot.manifest.modules.map((module) => {
      const captured = graphModulesById.get(module.id);
      return [
        module.id,
        captured ?? {
          id: module.id,
          identifier: module.identifier,
          resource: module.resource,
          moduleType: module.moduleType,
          chunks: module.chunks,
          providedExports: module.providedExports,
          usedExports: module.usedExports,
          optimizationBailout: module.optimizationBailout,
          originalSources: module.sourcePaths ?? (module.resource ? [module.resource] : []),
          transformedSource: null,
          sourceMap: null,
        },
      ] as const;
    }),
  );
  for (const [id, module] of graphModulesById) modulesById.set(id, module);
  const modules = [...moduleIds].flatMap((id) => {
    const module = modulesById.get(id);
    return module ? [module] : [];
  });
  const references = snapshot.exportGraph.edges
    .filter((edge) => moduleIds.has(edge.targetModuleId))
    .map((edge) => ({ edge, origin: modulesById.get(edge.originModuleId) ?? null }));
  const referenceKeys = new Set(
    references.map(({ edge }) => `${edge.originModuleId}\0${edge.targetModuleId}\0${edge.request}`),
  );
  for (const reference of snapshot.references) {
    if (!moduleIds.has(reference.targetId)) continue;
    const key = `${reference.originId}\0${reference.targetId}\0${reference.request}`;
    if (referenceKeys.has(key)) continue;
    references.push({
      edge: {
        originModuleId: reference.originId,
        targetModuleId: reference.targetId,
        resolvedModuleId: reference.targetId,
        dependencyType: reference.dependencyType ?? "unknown",
        request: reference.request,
        referencedPath: reference.exports,
        location: reference.sourceLocation ?? reference.location,
        active: reference.active !== false,
      },
      origin: modulesById.get(reference.originId) ?? null,
    });
  }
  return {
    buildHash: snapshot.manifest.hash,
    context: snapshot.manifest.context,
    source,
    content,
    modules,
    references,
    usedExportsEnabled: snapshot.manifest.capabilities.usedExports === "enabled",
    originalLocations: snapshot.manifest.capabilities.originalLocations,
  };
}

export class ExportAnalysisService {
  #jobsByKey = new Map<string, Job>();
  #jobsById = new Map<string, Job>();
  #generation = 0;
  #worker: Worker | null = null;

  reset(): void {
    this.#generation += 1;
    this.#jobsByKey.clear();
    this.#jobsById.clear();
  }

  request(snapshot: BuildSnapshot, source: string): SourceExportAnalysisStatus {
    const normalized = normalizeSourcePathForContext(source, snapshot.manifest.context);
    const key = `${snapshot.manifest.hash}\n${normalized}`;
    const existing = this.#jobsByKey.get(key);
    if (existing && existing.status.status !== "error") return existing.status;
    if (existing) {
      this.#jobsByKey.delete(existing.key);
      this.#jobsById.delete(existing.id);
    }

    const job: Job = {
      id: randomUUID(),
      key,
      generation: this.#generation,
      status: { status: "pending", phase: "Queued", completed: 0, total: 1 },
    };
    this.#jobsByKey.set(key, job);
    this.#jobsById.set(job.id, job);
    this.#run(job, prepareInput(snapshot, normalized));
    return job.status;
  }

  async close(): Promise<void> {
    const worker = this.#worker;
    this.#worker = null;
    if (worker) await worker.terminate();
  }

  #run(job: Job, input: ExportAnalysisInput): void {
    const worker = this.#getWorker();
    if (worker) {
      worker.postMessage({ id: job.id, input });
      return;
    }
    setImmediate(() => {
      void analyzeSourceExports(input, (phase, completed, total) => {
        this.#update(job.id, { status: "pending", phase, completed, total });
      })
        .then((report) => this.#update(job.id, { status: "complete", report }))
        .catch((error) =>
          this.#update(job.id, {
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
    });
  }

  #getWorker(): Worker | null {
    if (this.#worker) return this.#worker;
    const currentFile = fileURLToPath(import.meta.url);
    const extension = extname(currentFile) === ".cjs" ? ".cjs" : ".js";
    const workerFile = resolve(dirname(currentFile), `export-analysis-worker${extension}`);
    if (!existsSync(workerFile)) return null;
    const worker = new Worker(workerFile, {
      execArgv: process.execArgv.filter((argument) => !argument.startsWith("--input-type")),
    });
    worker.on("message", (message: WorkerMessage) => {
      if (message.type === "progress") {
        this.#update(message.id, {
          status: "pending",
          phase: message.phase,
          completed: message.completed,
          total: message.total,
        });
      } else if (message.type === "complete") {
        this.#update(message.id, { status: "complete", report: message.report });
      } else {
        this.#update(message.id, { status: "error", message: message.message });
      }
    });
    worker.on("error", (error) => {
      for (const job of this.#jobsById.values()) {
        if (job.status.status === "pending") {
          job.status = { status: "error", message: error.message };
        }
      }
      this.#worker = null;
    });
    this.#worker = worker;
    return worker;
  }

  #update(id: string, status: SourceExportAnalysisStatus): void {
    const job = this.#jobsById.get(id);
    if (!job || job.generation !== this.#generation) return;
    job.status = status;
  }
}

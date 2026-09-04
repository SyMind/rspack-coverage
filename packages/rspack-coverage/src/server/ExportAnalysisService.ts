import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { normalizeSourcePathForContext } from "../shared/path.js";
import type {
  BuildSnapshot,
  ExportAnalysisInput,
  ExportGraphModule,
  ExportReferenceEdge,
  SourceExportAnalysisStatus,
  SourceExportUsageReport,
} from "../shared/types.js";
import { analyzeSourceExports } from "./exportAnalysis.js";

const MAX_EXPORT_ANALYSIS_REFERENCES = 25_000;

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
  let match: string | null = null;
  for (const source of snapshot.originalSources.keys()) {
    if (!source.endsWith(`/${normalized}`) && !normalized.endsWith(`/${source}`)) continue;
    if (match !== null) return null;
    match = source;
  }
  return match;
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
  const directIds =
    snapshot.exportGraphStore?.moduleIdsForSource(source) ??
    snapshot.exportGraph.sourceToModuleIds[source] ??
    [];
  const moduleIds = new Set(directIds);
  if (moduleIds.size === 0 && !snapshot.exportGraphStore) {
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
  const manifestModules = new Map(snapshot.manifest.modules.map((module) => [module.id, module]));
  const inMemoryGraphModules = new Map(
    snapshot.exportGraph.modules.map((module) => [module.id, module]),
  );
  const moduleCache = new Map<string, ExportGraphModule | undefined>();
  const moduleForId = (id: string) => {
    if (moduleCache.has(id)) return moduleCache.get(id);
    const captured = snapshot.exportGraphStore?.getModule(id) ?? inMemoryGraphModules.get(id);
    if (captured) {
      moduleCache.set(id, captured);
      return captured;
    }
    const module = manifestModules.get(id);
    const resolved = module
      ? {
          id: module.id,
          identifier: module.identifier,
          readableIdentifier: module.readableIdentifier ?? module.name,
          resource: module.resource,
          moduleType: module.moduleType,
          chunks: module.chunks,
          providedExports: module.providedExports,
          usedExports: module.usedExports,
          optimizationBailout: module.optimizationBailout,
          originalSources: module.sourcePaths ?? (module.resource ? [module.resource] : []),
          transformedSource: null,
          sourceMap: null,
        }
      : undefined;
    moduleCache.set(id, resolved);
    return resolved;
  };
  const inferredOriginCache = new Map<string, ExportGraphModule>();
  const originForEdge = (edge: ExportReferenceEdge): ExportGraphModule | null => {
    const origin = moduleForId(edge.originModuleId);
    if (
      !origin ||
      origin.transformedSource ||
      edge.referencedPath !== null ||
      !edge.dependencyType.toLowerCase().includes("cjs")
    ) {
      return origin ?? null;
    }
    const cached = inferredOriginCache.get(origin.id);
    if (cached) return cached;
    const manifestModule = manifestModules.get(origin.id);
    const candidates = manifestModule
      ? [manifestModule.resource, ...(manifestModule.sourcePaths ?? [])]
      : [origin.resource, ...origin.originalSources];
    let transformedSource: string | null = null;
    for (const candidate of candidates) {
      if (!candidate) continue;
      const key = sourceKey(snapshot, candidate);
      if (!key) continue;
      const content = snapshot.originalSources.get(key);
      if (content === undefined) continue;
      transformedSource = content;
      break;
    }
    if (transformedSource === null) return origin;
    const inferredOrigin = { ...origin, transformedSource };
    inferredOriginCache.set(origin.id, inferredOrigin);
    return inferredOrigin;
  };
  const modules = [...moduleIds].flatMap((id) => {
    const module = moduleForId(id);
    return module ? [module] : [];
  });
  const buildReferenceCount =
    snapshot.referenceStore?.countTargets(moduleIds) ??
    snapshot.references.reduce(
      (total, reference) => total + Number(moduleIds.has(reference.targetId)),
      0,
    );
  if (buildReferenceCount > MAX_EXPORT_ANALYSIS_REFERENCES) {
    throw new Error(
      `Export analysis for ${source} has ${buildReferenceCount} direct references; the safe in-memory limit is ${MAX_EXPORT_ANALYSIS_REFERENCES}. Use the paged module reference view for the complete edge ledger.`,
    );
  }
  const graphEdges = snapshot.exportGraphStore
    ? snapshot.exportGraphStore.edgesForTargets(moduleIds)
    : snapshot.exportGraph.edges.filter((edge) => moduleIds.has(edge.targetModuleId));
  const references = graphEdges.map((edge) => ({
    edge,
    origin: originForEdge(edge),
  }));
  const referenceKeys = new Set(
    references.map(({ edge }) => `${edge.originModuleId}\0${edge.targetModuleId}\0${edge.request}`),
  );
  const buildReferences =
    snapshot.referenceStore?.forTargets(moduleIds) ??
    snapshot.references.filter((reference) => moduleIds.has(reference.targetId));
  for (const reference of buildReferences) {
    if (!moduleIds.has(reference.targetId)) continue;
    const key = `${reference.originId}\0${reference.targetId}\0${reference.request}`;
    if (referenceKeys.has(key)) continue;
    const edge: ExportReferenceEdge = {
      originModuleId: reference.originId,
      targetModuleId: reference.targetId,
      resolvedModuleId: reference.targetId,
      dependencyType: reference.dependencyType ?? "unknown",
      request: reference.request,
      referencedPath: reference.exports,
      location: reference.sourceLocation ?? reference.location,
      active: reference.active !== false,
      sourcePath: reference.sourcePath ?? null,
      originalLocation: Boolean(reference.sourcePath && reference.sourceLocation),
    };
    references.push({ edge, origin: originForEdge(edge) });
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
    try {
      this.#run(job, prepareInput(snapshot, normalized));
    } catch (error) {
      job.status = {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
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

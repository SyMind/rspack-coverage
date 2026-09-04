import { extname, isAbsolute } from "node:path";
import { sourceFileCoverageSpans } from "../shared/codeCoverage.js";
import { emptyMetrics, finalizeMetrics, metricsForModuleInstance } from "../shared/metrics.js";
import { normalizeSourcePathForContext } from "../shared/path.js";
import type {
  BuildModule,
  BuildReference,
  BuildReferenceStore,
  BuildSnapshot,
  CodeViewResponse,
  CoverageReport,
  ExportImporterBinding,
  ExportImporterChainResponse,
  ExportImporterChainStep,
  ExportUsageEdge,
  ExportUsageStore,
  ModuleInvestigationDetail,
  ModuleReferenceGraphEdge,
  ModuleReferenceGraphResponse,
  ModuleReferencesResponse,
  ReferenceLocation,
  ReferenceSnippetResponse,
  SourceFileReport,
  SourceFileSummary,
  SourceLineState,
  UsageMetrics,
} from "../shared/types.js";
import { parseExports } from "./exportAnalysis.js";
import { createInMemoryExportUsageStore } from "./exportUsageStore.js";
import { createInMemoryReferenceStore } from "./referenceStore.js";

const DEFAULT_CODE_LIMIT = 240_000;
const EXPORT_CHAIN_MAX_DEPTH = 12;
const EXPORT_CHAIN_MAX_STEPS = 120;
const EXPORT_CHAIN_MAX_INCOMING_PER_STATE = 250;
const EXPORT_BINDING_MAX_SOURCE_CHARACTERS = 512_000;
const EXPORT_BINDING_CACHE_LIMIT = 256;
const PARSED_EXPORT_CACHE_LIMIT = 128;
const MODULE_GRAPH_DEFAULT_DEPTH = 4;
const MODULE_GRAPH_MAX_DEPTH = 12;
const MODULE_GRAPH_MAX_NODES = 240;
const MODULE_GRAPH_MAX_EDGES = 480;
const MODULE_GRAPH_MAX_REFERENCES_PER_MODULE = 120;

function normalizeBuildSourcePath(value: string, context: string): string {
  return normalizeSourcePathForContext(value, context);
}

function locationFitsContent(content: string, location: ReferenceLocation | null): boolean {
  if (!location) return false;
  const lines = content.split("\n");
  const start = lines[location.start.line - 1];
  const end = lines[location.end.line - 1];
  return (
    start !== undefined &&
    end !== undefined &&
    location.start.column <= start.length &&
    location.end.column <= end.length + 1
  );
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function positionForOffset(starts: number[], offset: number): ReferenceLocation["start"] {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: offset - (starts[low] ?? 0) };
}

function searchedReferenceLocation(
  content: string,
  edge: BuildReference,
  hint: ReferenceLocation | null,
): ReferenceLocation | null {
  const terms = [edge.request, ...(edge.exports ?? [])].filter(
    (term, index, all): term is string => Boolean(term) && all.indexOf(term) === index,
  );
  const starts = lineStarts(content);
  for (const term of terms) {
    let bestOffset = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    let offset = content.indexOf(term);
    while (offset >= 0) {
      const position = positionForOffset(starts, offset);
      const distance = hint ? Math.abs(position.line - hint.start.line) : 0;
      if (distance < bestDistance) {
        bestOffset = offset;
        bestDistance = distance;
      }
      offset = content.indexOf(term, offset + Math.max(1, term.length));
    }
    if (bestOffset >= 0) {
      return {
        start: positionForOffset(starts, bestOffset),
        end: positionForOffset(starts, bestOffset + term.length),
      };
    }
  }
  return null;
}

function sliceCode(
  response: Omit<
    CodeViewResponse,
    "offset" | "endOffset" | "startLine" | "totalCharacters" | "hasPrevious" | "hasNext"
  >,
  requestedOffset: number,
  requestedLimit: number,
): CodeViewResponse {
  const totalCharacters = response.content.length;
  const offset = Math.max(0, Math.min(totalCharacters, Math.trunc(requestedOffset || 0)));
  const limit = Math.max(1, Math.min(500_000, Math.trunc(requestedLimit || DEFAULT_CODE_LIMIT)));
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

function unknownLines(content: string): SourceLineState[] {
  return content.split(/\r?\n/).map((text, index) => ({
    line: index + 1,
    text,
    buildState: "unknown",
    runtimeState: "not-loaded",
    emittedBytes: 0,
    loadedBytes: 0,
    executedBytes: 0,
    chunks: [],
    ranges: [],
  }));
}

function isDetailed(file: SourceFileSummary): file is SourceFileReport {
  return "content" in file && "lines" in file;
}

function referenceGroupKey(reference: BuildReference): string {
  return `${reference.originId}\0${reference.targetId}\0${reference.request ?? ""}`;
}

function referencesForExport(references: BuildReference[], exportedName: string): BuildReference[] {
  if (exportedName === "*") return references.filter((reference) => reference.active !== false);
  const explicitGroups = new Set(
    references
      .filter((reference) => reference.exports?.includes(exportedName))
      .map(referenceGroupKey),
  );
  return references.filter((reference) => {
    if (reference.active === false) return false;
    if (reference.exports?.includes(exportedName)) return true;
    return !reference.exports?.length && !explicitGroups.has(referenceGroupKey(reference));
  });
}

function moduleUsesExport(module: BuildModule, exportPath: readonly string[]): boolean {
  if (module.usedExports === true) return true;
  if (!Array.isArray(module.usedExports)) return false;
  const root = exportPath[0];
  return root === "*"
    ? module.usedExports.length > 0
    : Boolean(root && module.usedExports.includes(root));
}

function rangeDistance(range: ReferenceLocation, location: ReferenceLocation | null): number {
  if (!location) return 0;
  const point = location.start;
  if (
    (point.line > range.start.line ||
      (point.line === range.start.line && point.column >= range.start.column)) &&
    (point.line < range.end.line ||
      (point.line === range.end.line && point.column <= range.end.column))
  ) {
    return 0;
  }
  const startDistance =
    Math.abs(point.line - range.start.line) * 1_000_000 +
    Math.abs(point.column - range.start.column);
  const endDistance =
    Math.abs(point.line - range.end.line) * 1_000_000 + Math.abs(point.column - range.end.column);
  return Math.min(startDistance, endDistance);
}

function coverageStatus(
  line: SourceLineState | undefined,
): "executed" | "unexecuted" | "not-emitted" | "unloaded" | "unknown" {
  if (!line) return "unknown";
  if (line.buildState === "not-emitted") return "not-emitted";
  if (line.runtimeState === "executed") return "executed";
  if (line.runtimeState === "not-executed") return "unexecuted";
  if (line.runtimeState === "not-loaded") return "unloaded";
  return "unknown";
}

function sourceEvidenceScore(file: SourceFileReport, lineNumber: number): number {
  const line = file.lines[lineNumber - 1];
  if (!line) return 0;
  if (line.buildState !== "retained") return line.buildState === "unknown" ? 1 : 0;
  if (line.runtimeState === "executed") return 5;
  if (line.runtimeState === "not-executed") return 4;
  return line.runtimeState === "not-loaded" ? 3 : 2;
}

export class InvestigationModel {
  readonly summary: CoverageReport | null;
  readonly #modules: Map<string, BuildModule>;
  readonly #files = new Map<string, SourceFileSummary>();
  readonly #filesByModule = new Map<string, SourceFileSummary[]>();
  readonly #referenceStore: BuildReferenceStore;
  readonly #exportUsageStore: ExportUsageStore | null;
  readonly #entryPathCache = new Map<string, BuildModule[]>();
  readonly #exportBindingCache = new Map<string, Map<string, ExportImporterBinding>>();
  readonly #parsedExportCache = new Map<string, ReturnType<typeof parseExports>>();
  readonly #inferredUsageReferences = new Map<string, BuildReference>();

  #cacheEntryPath(moduleId: string, path: BuildModule[]): void {
    this.#entryPathCache.delete(moduleId);
    this.#entryPathCache.set(moduleId, path);
    while (this.#entryPathCache.size > 128) {
      const oldest = this.#entryPathCache.keys().next().value;
      if (oldest === undefined) break;
      this.#entryPathCache.delete(oldest);
    }
  }

  #cacheExportBindings(moduleId: string, bindings: Map<string, ExportImporterBinding>): void {
    this.#exportBindingCache.delete(moduleId);
    this.#exportBindingCache.set(moduleId, bindings);
    while (this.#exportBindingCache.size > EXPORT_BINDING_CACHE_LIMIT) {
      const oldest = this.#exportBindingCache.keys().next().value;
      if (oldest === undefined) break;
      this.#exportBindingCache.delete(oldest);
    }
  }

  #parsedExports(
    module: BuildModule,
    source: { path: string; content: string },
  ): ReturnType<typeof parseExports> {
    const key = `${module.id}\0${source.path}`;
    const cached = this.#parsedExportCache.get(key);
    if (cached) {
      this.#parsedExportCache.delete(key);
      this.#parsedExportCache.set(key, cached);
      return cached;
    }
    const parsed = parseExports(source.content, source.path, { includeImportUsages: true });
    this.#parsedExportCache.set(key, parsed);
    while (this.#parsedExportCache.size > PARSED_EXPORT_CACHE_LIMIT) {
      const oldest = this.#parsedExportCache.keys().next().value;
      if (oldest === undefined) break;
      this.#parsedExportCache.delete(oldest);
    }
    return parsed;
  }

  constructor(
    readonly snapshot: BuildSnapshot,
    report: CoverageReport | null = null,
    _matched?: unknown,
    _lineEvidence?: unknown,
    _analyzedAssetIds?: ReadonlySet<string>,
  ) {
    this.summary = report;
    this.#modules = new Map(snapshot.manifest.modules.map((module) => [module.id, module]));
    for (const file of report?.files ?? []) {
      this.#files.set(file.id, file);
      for (const moduleId of file.moduleIds) {
        const files = this.#filesByModule.get(moduleId) ?? [];
        files.push(file);
        this.#filesByModule.set(moduleId, files);
      }
    }
    this.#referenceStore =
      snapshot.referenceStore ?? createInMemoryReferenceStore(snapshot.references);
    this.#exportUsageStore =
      snapshot.manifest.capabilities.exportUsageGraph === "native"
        ? (snapshot.exportUsageStore ??
          createInMemoryExportUsageStore(snapshot.exportUsageEdges ?? []))
        : null;
  }

  #sourceCandidates(path: string): Array<{ key: string; path: string }> {
    const normalized = normalizeBuildSourcePath(path, this.snapshot.manifest.context);
    const candidates: Array<{ key: string; path: string }> = [];
    for (const candidate of this.snapshot.originalSources.keys()) {
      const current = normalizeBuildSourcePath(candidate, this.snapshot.manifest.context);
      if (
        current === normalized ||
        current.endsWith(`/${normalized}`) ||
        normalized.endsWith(`/${current}`)
      ) {
        candidates.push({ key: candidate, path: current });
      }
    }
    return candidates.sort(
      (left, right) =>
        Number(right.path === normalized) - Number(left.path === normalized) ||
        left.path.length - right.path.length,
    );
  }

  #sourceContent(path: string): string | null {
    const candidate = this.#sourceCandidates(path)[0];
    return candidate ? (this.snapshot.originalSources.get(candidate.key) ?? null) : null;
  }

  #sourceForModule(module: BuildModule): { path: string; content: string } | null {
    const requestedPaths = [...(module.sourcePaths ?? []), module.resource].filter(
      (path): path is string => Boolean(path),
    );
    for (const requestedPath of requestedPaths) {
      const normalized = normalizeBuildSourcePath(requestedPath, this.snapshot.manifest.context);
      for (const key of [requestedPath, normalized]) {
        if (!this.snapshot.originalSources.has(key)) continue;
        const content = this.snapshot.originalSources.get(key);
        if (content !== undefined) return { path: normalized, content };
      }
    }
    for (const requestedPath of requestedPaths) {
      const candidate = this.#sourceCandidates(requestedPath)[0];
      if (!candidate) continue;
      const content = this.snapshot.originalSources.get(candidate.key);
      if (content !== undefined) return { path: candidate.path, content };
    }
    return null;
  }

  #sourceForReference(
    module: BuildModule,
    reference: BuildReference,
  ): { path: string; content: string } | null {
    if (reference.sourcePath) {
      const candidate = this.#sourceCandidates(reference.sourcePath)[0];
      if (candidate) {
        const content = this.snapshot.originalSources.get(candidate.key);
        if (content !== undefined) return { path: candidate.path, content };
      }
    }
    return this.#sourceForModule(module);
  }

  #exportBindings(module: BuildModule): Map<string, ExportImporterBinding> {
    const cached = this.#exportBindingCache.get(module.id);
    if (cached) {
      this.#exportBindingCache.delete(module.id);
      this.#exportBindingCache.set(module.id, cached);
      return cached;
    }
    const bindings = new Map<string, ExportImporterBinding>();
    for (const exportedName of module.providedExports ?? []) {
      if (exportedName === "__esModule") continue;
      bindings.set(exportedName, {
        exportedName,
        localName: null,
        exportPath: [exportedName],
        declaration: null,
      });
    }
    const source = this.#sourceForModule(module);
    if (source && source.content.length <= EXPORT_BINDING_MAX_SOURCE_CHARACTERS) {
      for (const item of this.#parsedExports(module, source).exports) {
        if (item.typeOnly) continue;
        const existing = bindings.get(item.exportedName);
        bindings.set(item.exportedName, {
          exportedName: item.exportedName,
          localName: existing?.localName ?? item.localName,
          exportPath: [item.exportedName],
          declaration: item.declarationRange
            ? { sourcePath: source.path, range: item.declarationRange }
            : (existing?.declaration ?? null),
        });
      }
    }
    this.#cacheExportBindings(module.id, bindings);
    return bindings;
  }

  #exportBinding(module: BuildModule, value: string | readonly string[]): ExportImporterBinding {
    const exportPath = typeof value === "string" ? [value] : [...value];
    const exportedName = exportPath.join(".");
    const rootName = exportPath[0] ?? exportedName;
    const root = this.#exportBindings(module).get(rootName);
    if (root && exportPath.length === 1) return root;
    return {
      exportedName,
      localName:
        root?.localName && exportPath.length > 1
          ? [root.localName, ...exportPath.slice(1)].join(".")
          : null,
      exportPath,
      declaration: root?.declaration ?? null,
    };
  }

  #importerExportCandidates(
    module: BuildModule,
    reference: BuildReference,
    importedExport: string,
  ): {
    exports: string[];
    precision: ExportImporterChainStep["relationPrecision"];
    usage: { sourcePath: string; range: ReferenceLocation } | null;
  } {
    const source = this.#sourceForReference(module, reference);
    if (!source || source.content.length > EXPORT_BINDING_MAX_SOURCE_CHARACTERS) {
      return { exports: [], precision: "unavailable", usage: null };
    }
    const parsed = this.#parsedExports(module, source);
    if (parsed.importUsagesTruncated) {
      return { exports: [], precision: "unavailable", usage: null };
    }
    const matching = parsed.importUsages.filter(
      (usage) =>
        usage.request === reference.request &&
        (importedExport === "*" ||
          usage.importedName === importedExport ||
          usage.importedName === "*"),
    );
    if (!matching.length) return { exports: [], precision: "unavailable", usage: null };

    const hint = reference.sourceLocation ?? reference.location;
    let selected = matching;
    if (hint && matching.length > 1) {
      const minimumDistance = Math.min(
        ...matching.map((usage) => rangeDistance(usage.range, hint)),
      );
      if (minimumDistance === 0) {
        selected = matching.filter((usage) => rangeDistance(usage.range, hint) === 0);
      } else {
        const line = source.content.split(/\r?\n/)[hint.start.line - 1] ?? "";
        if (line.includes(importedExport)) {
          selected = matching.filter(
            (usage) => rangeDistance(usage.range, hint) === minimumDistance,
          );
        }
      }
    }
    const exports = [
      ...new Set(
        selected.flatMap((usage) =>
          usage.importerExports.map((name) => (name === "*" ? importedExport : name)),
        ),
      ),
    ];
    const signatures = new Set(
      selected.map((usage) =>
        usage.importerExports
          .map((name) => (name === "*" ? importedExport : name))
          .sort()
          .join("\0"),
      ),
    );
    const selectedUsage = selected.find((usage) => usage.importerExports.length > 0) ?? selected[0];
    if (!selectedUsage) return { exports: [], precision: "unavailable", usage: null };
    return {
      exports,
      precision: signatures.size <= 1 ? "exact" : "conservative",
      usage: {
        sourcePath: source.path,
        range: selectedUsage.range,
      },
    };
  }

  #cacheInferredUsageReference(reference: BuildReference): void {
    this.#inferredUsageReferences.delete(reference.id);
    this.#inferredUsageReferences.set(reference.id, reference);
    while (this.#inferredUsageReferences.size > EXPORT_CHAIN_MAX_STEPS * 4) {
      const oldest = this.#inferredUsageReferences.keys().next().value;
      if (oldest === undefined) break;
      this.#inferredUsageReferences.delete(oldest);
    }
  }

  #filesForModule(moduleId: string): SourceFileSummary[] {
    const direct = this.#filesByModule.get(moduleId) ?? [];
    if (direct.length) return direct;
    const module = this.#modules.get(moduleId);
    if (!module?.resource) return [];
    const resource = normalizeBuildSourcePath(module.resource, this.snapshot.manifest.context);
    return [...this.#files.values()].filter(
      (file) =>
        file.path === resource ||
        file.path.endsWith(`/${resource}`) ||
        resource.endsWith(`/${file.path}`),
    );
  }

  #metrics(moduleId: string): UsageMetrics {
    const metrics = emptyMetrics();
    const module = this.#modules.get(moduleId);
    for (const file of this.#filesForModule(moduleId)) {
      const sourceMetrics = metricsForModuleInstance(file, module);
      metrics.emittedBytes += sourceMetrics.emittedBytes;
      metrics.loadedBytes += sourceMetrics.loadedBytes;
      metrics.executedBytes += sourceMetrics.executedBytes;
      metrics.mappedBytes += sourceMetrics.mappedBytes;
      metrics.unmappedBytes += sourceMetrics.unmappedBytes;
    }
    return finalizeMetrics(metrics);
  }

  source(fileId: string): SourceFileReport | null {
    const file = this.#files.get(fileId);
    if (!file) return null;
    if (isDetailed(file)) return file;
    const content = this.#sourceContent(file.path);
    return { ...file, content, lines: content === null ? [] : unknownLines(content) };
  }

  module(moduleId: string): ModuleInvestigationDetail | null {
    const module = this.#modules.get(moduleId);
    if (!module) return null;
    const files = this.#filesForModule(moduleId);
    const metrics = this.#metrics(moduleId);
    const source = files.some((file) => this.#sourceContent(file.path) !== null);
    const codeGeneration =
      (this.snapshot.codeGeneration.get(moduleId)?.length ?? 0) > 0 ||
      (this.snapshot.loadCodeGeneration?.(moduleId).length ?? 0) > 0;
    const hasMappedOutput = metrics.mappedBytes > 0;
    return {
      ...module,
      sources: files.map((file) => {
        const sourceMetrics = metricsForModuleInstance(file, module);
        return {
          id: file.id,
          name: file.path,
          mappedBytes: sourceMetrics.mappedBytes,
          loadedBytes: sourceMetrics.loadedBytes,
          executedBytes: sourceMetrics.executedBytes,
        };
      }),
      metrics,
      incomingReferences: this.#referenceStore.count(moduleId, "in"),
      outgoingReferences: this.#referenceStore.count(moduleId, "out"),
      views: {
        source,
        output: hasMappedOutput || codeGeneration,
        finalAsset: hasMappedOutput,
        codeGeneration,
        hasMappedOutput,
        preferred: !hasMappedOutput && codeGeneration ? "output" : source ? "source" : "output",
        outputKind: hasMappedOutput
          ? "final-asset"
          : codeGeneration
            ? "module-code-generation"
            : null,
      },
    };
  }

  code(
    moduleId: string,
    view: "source" | "output",
    sourceId: string | null,
    offset = 0,
    limit = DEFAULT_CODE_LIMIT,
  ): CodeViewResponse | null {
    const module = this.#modules.get(moduleId);
    if (!module) return null;
    if (view === "source") {
      const files = this.#filesForModule(moduleId);
      const selected = files.find((file) => file.id === sourceId) ?? files[0];
      const detail = selected ? this.source(selected.id) : null;
      const content = detail?.content ?? "";
      return sliceCode(
        {
          view,
          sourceId: detail?.id ?? null,
          filename: detail?.path ?? module.name,
          language: extname(detail?.path ?? module.name).slice(1) || "javascript",
          content,
          spans: detail ? sourceFileCoverageSpans(detail) : [],
          provenance: content ? "captured-original-source" : "unavailable",
          gap: content ? null : "Source content is unavailable",
        },
        offset,
        limit,
      );
    }
    const generated =
      this.snapshot.codeGeneration.get(moduleId)?.[0] ??
      this.snapshot.loadCodeGeneration?.(moduleId)[0];
    const content = generated?.content ?? "";
    return sliceCode(
      {
        view,
        sourceId: null,
        filename: `${module.name} · generated output`,
        language: "javascript",
        content,
        spans: content ? [{ start: 0, end: content.length, status: "unknown" }] : [],
        provenance: generated ? "module-code-generation" : "unavailable",
        gap: generated
          ? "Exact final-asset runtime coverage is unavailable for this module view."
          : "No module code-generation source is available",
      },
      offset,
      limit,
    );
  }

  entryPath(moduleId: string): BuildModule[] {
    const cached = this.#entryPathCache.get(moduleId);
    if (cached) return cached;
    const queue: string[][] = [[moduleId]];
    const visited = new Set([moduleId]);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const path = queue[cursor] ?? [];
      const currentId = path.at(-1);
      const current = currentId ? this.#modules.get(currentId) : null;
      if (current?.entry) {
        const result = path.flatMap((id) => {
          const module = this.#modules.get(id);
          return module ? [module] : [];
        });
        this.#cacheEntryPath(moduleId, result);
        return result;
      }
      if (!currentId) continue;
      for (const consumer of this.#referenceStore.incomingOrigins(currentId)) {
        if (!consumer || visited.has(consumer)) continue;
        visited.add(consumer);
        queue.push([...path, consumer]);
      }
    }
    this.#cacheEntryPath(moduleId, []);
    return [];
  }

  references(
    moduleId: string,
    direction: "in" | "out" | "both" = "both",
    cursor = 0,
    limit = 80,
    graphDepth = MODULE_GRAPH_DEFAULT_DEPTH,
  ): ModuleReferencesResponse | null {
    const module = this.#modules.get(moduleId);
    if (!module) return null;
    const safeCursor = Math.max(0, Math.trunc(cursor || 0));
    const safeLimit = Math.max(1, Math.min(250, Math.trunc(limit || 80)));
    const counts = {
      in: this.#referenceStore.count(moduleId, "in"),
      out: this.#referenceStore.count(moduleId, "out"),
      both: this.#referenceStore.count(moduleId, "both"),
    };
    const total = counts[direction];
    const page = this.#referenceStore.page(moduleId, direction, safeCursor, safeLimit);
    return {
      module,
      direction,
      counts,
      total,
      cursor: safeCursor,
      nextCursor: safeCursor + page.length < total ? safeCursor + page.length : null,
      edges: page.flatMap((edge) => {
        const origin = edge ? this.#modules.get(edge.originId) : null;
        const target = edge ? this.#modules.get(edge.targetId) : null;
        return edge && origin && target ? [{ ...edge, origin, target }] : [];
      }),
      entryPath: this.entryPath(moduleId),
      graph: this.#moduleReferenceGraph(moduleId, direction, graphDepth),
    };
  }

  #moduleReferenceGraph(
    moduleId: string,
    direction: "in" | "out" | "both",
    requestedDepth: number,
  ): ModuleReferenceGraphResponse {
    const depthLimit = Math.max(
      1,
      Math.min(MODULE_GRAPH_MAX_DEPTH, Math.trunc(requestedDepth || MODULE_GRAPH_DEFAULT_DEPTH)),
    );
    const root = this.#modules.get(moduleId);
    const nodes = new Map<string, { module: BuildModule; depth: number; discoveryOrder: number }>();
    if (root) nodes.set(root.id, { module: root, depth: 0, discoveryOrder: 0 });

    type TraversalDirection = "in" | "out";
    type PendingModule = { moduleId: string; depth: number; direction: TraversalDirection };
    const queue: PendingModule[] = [];
    if (direction !== "out") queue.push({ moduleId, depth: 0, direction: "in" });
    if (direction !== "in") queue.push({ moduleId, depth: 0, direction: "out" });
    const visited = new Set<string>();
    const graphEdges = new Map<
      string,
      { edge: ModuleReferenceGraphEdge; referenceIds: Set<string> }
    >();
    const truncation = { depth: false, nodes: false, edges: false, perModule: false };
    let reachedDepth = 0;
    let cursorIndex = 0;

    while (cursorIndex < queue.length) {
      const current = queue[cursorIndex];
      cursorIndex += 1;
      if (!current) continue;
      const visitKey = `${current.direction}\0${current.moduleId}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);

      const nextDistance = Math.abs(current.depth) + 1;
      const available = this.#referenceStore.count(current.moduleId, current.direction);
      if (nextDistance > depthLimit) {
        if (available > 0) truncation.depth = true;
        continue;
      }
      const referenceLimit = Math.min(available, MODULE_GRAPH_MAX_REFERENCES_PER_MODULE);
      if (available > referenceLimit) truncation.perModule = true;
      const references = this.#referenceStore.page(
        current.moduleId,
        current.direction,
        0,
        referenceLimit,
      );

      for (const reference of references) {
        const neighborId = current.direction === "in" ? reference.originId : reference.targetId;
        if (neighborId === current.moduleId) continue;
        const neighbor = this.#modules.get(neighborId);
        if (!neighbor) continue;
        const neighborDepth = current.direction === "in" ? -nextDistance : nextDistance;
        const edgeKey = `${reference.originId}\0${reference.targetId}`;
        const existingEdge = graphEdges.get(edgeKey);
        if (!existingEdge && graphEdges.size >= MODULE_GRAPH_MAX_EDGES) {
          truncation.edges = true;
          continue;
        }
        const existingNode = nodes.get(neighborId);
        if (!existingNode) {
          if (nodes.size >= MODULE_GRAPH_MAX_NODES) {
            truncation.nodes = true;
            continue;
          }
          nodes.set(neighborId, {
            module: neighbor,
            depth: neighborDepth,
            discoveryOrder: nodes.size,
          });
          reachedDepth = Math.max(reachedDepth, nextDistance);
        }

        if (existingEdge) {
          if (!existingEdge.referenceIds.has(reference.id)) {
            existingEdge.referenceIds.add(reference.id);
            existingEdge.edge.referenceCount += 1;
          }
        } else {
          graphEdges.set(edgeKey, {
            edge: { ...reference, referenceCount: 1 },
            referenceIds: new Set([reference.id]),
          });
        }

        const nextVisitKey = `${current.direction}\0${neighborId}`;
        if (!visited.has(nextVisitKey)) {
          queue.push({ moduleId: neighborId, depth: neighborDepth, direction: current.direction });
        }
      }
    }

    return {
      direction,
      requestedDepth: depthLimit,
      reachedDepth,
      nodes: [...nodes.values()]
        .sort((left, right) => left.discoveryOrder - right.discoveryOrder)
        .map(({ module, depth }) => ({ module, depth })),
      edges: [...graphEdges.values()].map(({ edge }) => edge),
      truncated: Object.values(truncation).some(Boolean),
      truncation,
      limits: {
        maxDepth: MODULE_GRAPH_MAX_DEPTH,
        maxNodes: MODULE_GRAPH_MAX_NODES,
        maxEdges: MODULE_GRAPH_MAX_EDGES,
      },
    };
  }

  #nativeExportImporterChain(
    module: BuildModule,
    exportedName: string,
  ): ExportImporterChainResponse {
    const store = this.#exportUsageStore as ExportUsageStore;
    type PendingState = {
      moduleId: string;
      exportPath: string[];
      depth: number;
      parentId: string | null;
      ancestors: ReadonlySet<string>;
      allowSourceFallback: boolean;
    };
    const rootPath = [exportedName];
    const rootKey = `${module.id}\0${JSON.stringify(rootPath)}`;
    const queue: PendingState[] = [
      {
        moduleId: module.id,
        exportPath: rootPath,
        depth: 0,
        parentId: null,
        ancestors: new Set([rootKey]),
        allowSourceFallback: false,
      },
    ];
    const steps: ExportImporterChainStep[] = [];
    const visited = new Set<string>();
    let truncated = false;
    let usedNative = false;
    let usedFallback = false;
    let cursor = 0;

    while (cursor < queue.length && steps.length < EXPORT_CHAIN_MAX_STEPS) {
      const state = queue[cursor];
      cursor += 1;
      if (!state) continue;
      const stateKey = `${state.moduleId}\0${JSON.stringify(state.exportPath)}`;
      if (visited.has(stateKey)) continue;
      visited.add(stateKey);
      const current = this.#modules.get(state.moduleId);
      if (!current) continue;
      const wildcard = state.exportPath.length === 1 && state.exportPath[0] === "*";
      const incomingCount = wildcard ? 0 : store.countTarget(state.moduleId, state.exportPath);
      const canFallback =
        state.allowSourceFallback || wildcard || moduleUsesExport(current, state.exportPath);
      if (state.depth >= EXPORT_CHAIN_MAX_DEPTH) {
        if (
          incomingCount > 0 ||
          (canFallback && this.#referenceStore.count(state.moduleId, "in") > 0)
        ) {
          truncated = true;
        }
        continue;
      }
      if (incomingCount > 0) {
        usedNative = true;
        const incomingLimit = Math.min(incomingCount, EXPORT_CHAIN_MAX_INCOMING_PER_STATE);
        if (incomingCount > incomingLimit) truncated = true;
        const incoming = store.pageTarget(state.moduleId, state.exportPath, 0, incomingLimit);
        const grouped = new Map<string, ExportUsageEdge[]>();
        for (const edge of incoming) {
          const key = `${edge.originModuleId}\0${edge.targetModuleId}\0${edge.dependencyId}\0${JSON.stringify(
            edge.targetExport,
          )}\0${JSON.stringify(edge.sourceLocation ?? edge.location)}`;
          const values = grouped.get(key) ?? [];
          values.push(edge);
          grouped.set(key, values);
        }

        for (const group of grouped.values()) {
          if (steps.length >= EXPORT_CHAIN_MAX_STEPS) {
            truncated = true;
            break;
          }
          const first = group[0];
          if (!first) continue;
          const origin = this.#modules.get(first.originModuleId);
          const target = this.#modules.get(first.targetModuleId);
          if (!origin || !target) continue;
          const carrierPaths = [
            ...new Map(
              group.flatMap((edge) =>
                edge.originExport
                  ? [[JSON.stringify(edge.originExport), edge.originExport] as const]
                  : [],
              ),
            ).values(),
          ];
          const importerBindings = carrierPaths.map((path) => this.#exportBinding(origin, path));
          const id = `${first.id}:${state.depth + 1}:${steps.length}`;
          const reference: BuildReference = {
            id: first.id,
            originId: origin.id,
            targetId: target.id,
            dependencyType: "export usage",
            request: target.resource,
            exports: first.targetExport ? [...first.targetExport] : [...state.exportPath],
            active: true,
            location: first.location,
            sourcePath: first.sourcePath ?? origin.resource,
            sourceLocation: first.sourceLocation ?? first.location,
          };
          steps.push({
            id,
            parentId: state.parentId,
            depth: state.depth + 1,
            importedExport: (first.targetExport ?? state.exportPath).join("."),
            importedBinding: this.#exportBinding(target, first.targetExport ?? state.exportPath),
            importerExports: importerBindings.map((binding) => binding.exportedName),
            importerBindings,
            relationPrecision: "exact",
            usageEdgeId: first.id,
            edge: { ...reference, origin, target },
          });
          for (const carrierPath of carrierPaths) {
            const carrierKey = `${origin.id}\0${JSON.stringify(carrierPath)}`;
            if (state.ancestors.has(carrierKey)) continue;
            queue.push({
              moduleId: origin.id,
              exportPath: [...carrierPath],
              depth: state.depth + 1,
              parentId: id,
              ancestors: new Set([...state.ancestors, carrierKey]),
              allowSourceFallback: state.allowSourceFallback,
            });
          }
        }
        continue;
      }

      if (!canFallback) continue;
      const referenceCount = this.#referenceStore.count(state.moduleId, "in");
      const referenceLimit = Math.min(referenceCount, EXPORT_CHAIN_MAX_INCOMING_PER_STATE);
      if (referenceCount > referenceLimit) truncated = true;
      const incoming = this.#referenceStore.page(state.moduleId, "in", 0, referenceLimit);
      const importedExport = state.exportPath.join(".");
      const fallbackEdges = referencesForExport(incoming, importedExport);
      if (fallbackEdges.length === 0) continue;
      usedFallback = true;
      for (const edge of fallbackEdges) {
        if (steps.length >= EXPORT_CHAIN_MAX_STEPS) {
          truncated = true;
          break;
        }
        const origin = this.#modules.get(edge.originId);
        const target = this.#modules.get(edge.targetId);
        if (!origin || !target) continue;
        const importer = this.#importerExportCandidates(origin, edge, importedExport);
        const importerExports =
          importer.exports.length > 0
            ? importer.exports
            : importer.precision === "unavailable" && origin.usedExports === true
              ? ["*"]
              : [];
        const relationPrecision =
          importerExports.length > 0 && importer.exports.length === 0
            ? "conservative"
            : importer.precision;
        const usage = importer.usage;
        const usageLocation = usage?.range ?? null;
        const usageReferenceId = usageLocation
          ? `inferred-export-usage:${edge.id}:${JSON.stringify(state.exportPath)}:${usageLocation.start.line}:${usageLocation.start.column}`
          : edge.id;
        const reference: BuildReference = usageLocation
          ? {
              ...edge,
              id: usageReferenceId,
              exports: wildcard ? null : [...state.exportPath],
              sourcePath: usage?.sourcePath ?? edge.sourcePath ?? null,
              sourceLocation: usageLocation,
            }
          : edge;
        if (usageLocation) this.#cacheInferredUsageReference(reference);
        const importerBindings = importerExports.map((name) => this.#exportBinding(origin, name));
        const id = `source:${edge.id}:${importedExport}:${state.depth + 1}:${steps.length}`;
        steps.push({
          id,
          parentId: state.parentId,
          depth: state.depth + 1,
          importedExport,
          importedBinding: this.#exportBinding(target, state.exportPath),
          importerExports,
          importerBindings,
          relationPrecision,
          ...(usageLocation ? { usageEdgeId: usageReferenceId } : {}),
          edge: { ...reference, origin, target },
        });
        for (const importerExport of importerExports) {
          const carrierPath = [importerExport];
          const carrierKey = `${origin.id}\0${JSON.stringify(carrierPath)}`;
          if (state.ancestors.has(carrierKey)) continue;
          queue.push({
            moduleId: origin.id,
            exportPath: carrierPath,
            depth: state.depth + 1,
            parentId: id,
            ancestors: new Set([...state.ancestors, carrierKey]),
            allowSourceFallback: true,
          });
        }
      }
    }
    if (cursor < queue.length) truncated = true;
    const precision = usedFallback ? (usedNative ? "mixed" : "source-inferred") : "native";
    return {
      module,
      exportedName,
      binding: this.#exportBinding(module, rootPath),
      steps,
      precision,
      diagnostics: usedFallback
        ? [
            "Rspack's native export usage graph was used where available. Missing hops for exports marked as used were inferred from active module references and captured source.",
          ]
        : [],
      truncated,
      maxDepth: EXPORT_CHAIN_MAX_DEPTH,
    };
  }

  exportImporterChain(moduleId: string, exportedName: string): ExportImporterChainResponse | null {
    const module = this.#modules.get(moduleId);
    if (!module) return null;
    const normalizedExport = exportedName.trim();
    if (!normalizedExport) return null;
    if (this.#exportUsageStore) {
      return this.#nativeExportImporterChain(module, normalizedExport);
    }

    type PendingState = {
      moduleId: string;
      exportedName: string;
      depth: number;
      parentId: string | null;
    };
    const queue: PendingState[] = [
      { moduleId, exportedName: normalizedExport, depth: 0, parentId: null },
    ];
    const visited = new Set<string>();
    const steps: ExportImporterChainStep[] = [];
    let truncated = false;

    for (
      let cursor = 0;
      cursor < queue.length && steps.length < EXPORT_CHAIN_MAX_STEPS;
      cursor += 1
    ) {
      const state = queue[cursor];
      if (!state) continue;
      const stateKey = `${state.moduleId}\0${state.exportedName}`;
      if (visited.has(stateKey)) continue;
      visited.add(stateKey);
      if (state.depth >= EXPORT_CHAIN_MAX_DEPTH) {
        if (this.#referenceStore.count(state.moduleId, "in") > 0) truncated = true;
        continue;
      }

      const incomingCount = this.#referenceStore.count(state.moduleId, "in");
      const incomingLimit = Math.min(incomingCount, EXPORT_CHAIN_MAX_INCOMING_PER_STATE);
      if (incomingCount > incomingLimit) truncated = true;
      const incoming = this.#referenceStore.page(state.moduleId, "in", 0, incomingLimit);
      for (const edge of referencesForExport(incoming, state.exportedName)) {
        if (steps.length >= EXPORT_CHAIN_MAX_STEPS) {
          truncated = true;
          break;
        }
        const origin = this.#modules.get(edge.originId);
        const target = this.#modules.get(edge.targetId);
        if (!origin || !target) continue;
        const importer = this.#importerExportCandidates(origin, edge, state.exportedName);
        const id = `${edge.id}:${state.exportedName}:${state.depth + 1}`;
        steps.push({
          id,
          parentId: state.parentId,
          depth: state.depth + 1,
          importedExport: state.exportedName,
          importedBinding: this.#exportBinding(target, state.exportedName),
          importerExports: importer.exports,
          importerBindings: importer.exports.map((name) => this.#exportBinding(origin, name)),
          relationPrecision: importer.precision,
          edge: { ...edge, origin, target },
        });
        for (const importerExport of importer.exports) {
          queue.push({
            moduleId: origin.id,
            exportedName: importerExport,
            depth: state.depth + 1,
            parentId: id,
          });
        }
      }
    }
    if (queue.some((state) => !visited.has(`${state.moduleId}\0${state.exportedName}`))) {
      truncated = true;
    }
    return {
      module,
      exportedName: normalizedExport,
      binding: this.#exportBinding(module, normalizedExport),
      steps,
      precision: "source-inferred",
      diagnostics: [
        "This snapshot does not contain Rspack's native export usage graph. The visible chain is inferred from captured source and stops when ownership is unavailable.",
      ],
      truncated,
      maxDepth: EXPORT_CHAIN_MAX_DEPTH,
    };
  }

  #snippetForEdge(
    edge: BuildReference,
    kind: "usage" | "declaration",
    title?: string,
  ): ReferenceSnippetResponse {
    const origin = this.#modules.get(edge.originId);
    const requestedPath = edge.sourcePath ?? origin?.resource ?? null;
    const compilerLocation = edge.sourceLocation ?? edge.location;
    const candidates = requestedPath ? this.#sourceCandidates(requestedPath) : [];
    let selected: { path: string; content: string; location: ReferenceLocation } | null = null;
    for (const candidate of candidates) {
      const content = this.snapshot.originalSources.get(candidate.key);
      if (content !== undefined && locationFitsContent(content, compilerLocation)) {
        selected = {
          path: candidate.path,
          content,
          location: compilerLocation as ReferenceLocation,
        };
        break;
      }
    }
    if (!selected) {
      for (const candidate of candidates) {
        const content = this.snapshot.originalSources.get(candidate.key);
        const location = content
          ? searchedReferenceLocation(content, edge, compilerLocation)
          : null;
        if (content !== undefined && location) {
          selected = { path: candidate.path, content, location };
          break;
        }
      }
    }
    const content = selected?.content ?? null;
    const location = selected?.location ?? null;
    if (!selected || !content || !location) {
      return {
        edge,
        kind,
        ...(title ? { title } : {}),
        available: false,
        gap:
          candidates.length > 0
            ? "Reference location is unavailable and the dependency request was not found"
            : "Consumer source is unavailable",
      };
    }
    const lines = content.split("\n");
    const starts = lineStarts(content);
    const start = (starts[location.start.line - 1] ?? 0) + location.start.column;
    const end = Math.max(start + 1, (starts[location.end.line - 1] ?? start) + location.end.column);
    const selectedFilename = normalizeBuildSourcePath(
      selected.path,
      this.snapshot.manifest.context,
    );
    const detailedOrigin = origin
      ? (this.#filesForModule(origin.id)
          .map((file) => this.source(file.id))
          .filter((file): file is SourceFileReport => file?.content === content)
          .sort(
            (left, right) =>
              sourceEvidenceScore(right, location.start.line) -
                sourceEvidenceScore(left, location.start.line) ||
              Number(right.path === selectedFilename) - Number(left.path === selectedFilename),
          )[0] ?? null)
      : null;
    const filename = detailedOrigin?.path ?? selectedFilename;
    const code: CodeViewResponse = {
      view: "source",
      sourceId: detailedOrigin?.id ?? null,
      filename,
      language: extname(filename).slice(1) || "javascript",
      content,
      spans: detailedOrigin
        ? sourceFileCoverageSpans(detailedOrigin)
        : [{ start: 0, end: content.length, status: "unknown" }],
      offset: 0,
      endOffset: content.length,
      startLine: 1,
      totalCharacters: content.length,
      hasPrevious: false,
      hasNext: false,
      provenance: detailedOrigin ? "coverage-analysis" : "captured-original-source",
      gap: null,
    };
    return {
      edge,
      kind,
      ...(title ? { title } : {}),
      available: true,
      gap: null,
      code,
      filename,
      startLine: 1,
      endLine: lines.length,
      highlight: {
        start: Math.min(content.length, start),
        end: Math.min(content.length, end),
        coverageStatus: coverageStatus(detailedOrigin?.lines[location.start.line - 1]),
      },
      coverage: origin ? this.#metrics(origin.id) : emptyMetrics(),
      location,
    };
  }

  snippet(referenceId: string, _contextLines = 3): ReferenceSnippetResponse | null {
    const reference =
      this.#inferredUsageReferences.get(referenceId) ?? this.#referenceStore.get(referenceId);
    if (reference) return this.#snippetForEdge(reference, "usage");
    const usage = this.#exportUsageStore?.get(referenceId);
    if (!usage) return null;
    const target = this.#modules.get(usage.targetModuleId);
    const edge: BuildReference = {
      id: usage.id,
      originId: usage.originModuleId,
      targetId: usage.targetModuleId,
      dependencyType: "export usage",
      request: target?.resource ?? null,
      exports: usage.targetExport,
      active: true,
      location: usage.location,
      sourcePath: usage.sourcePath ?? null,
      sourceLocation: usage.sourceLocation ?? usage.location,
    };
    return this.#snippetForEdge(edge, "usage");
  }

  exportDeclaration(moduleId: string, exportedName: string): ReferenceSnippetResponse | null {
    const module = this.#modules.get(moduleId);
    if (!module) return null;
    const binding = this.#exportBinding(module, exportedName);
    if (!binding.declaration) return null;
    const edge: BuildReference = {
      id: `declaration:${module.id}:${exportedName}`,
      originId: module.id,
      targetId: module.id,
      dependencyType: "export declaration",
      request: null,
      exports: [exportedName],
      active: true,
      location: binding.declaration.range,
      sourcePath: binding.declaration.sourcePath,
      sourceLocation: binding.declaration.range,
    };
    return this.#snippetForEdge(
      edge,
      "declaration",
      `Definition of ${binding.localName ?? binding.exportedName}`,
    );
  }

  aiContext(moduleId: string): unknown | null {
    const module = this.module(moduleId);
    if (!module) return null;
    return {
      schemaVersion: 1,
      kind: "rspack-module-coverage-ai-context",
      build: { hash: this.snapshot.manifest.hash, mode: this.snapshot.manifest.mode },
      module,
      references: this.references(moduleId, "both", 0, 30),
      evidenceGaps: this.evidenceGaps(),
    };
  }

  evidenceGaps(): Array<{ kind: string; message: string }> {
    return this.snapshot.manifest.diagnostics.map((diagnostic) => ({
      kind: diagnostic.severity,
      message: diagnostic.message,
    }));
  }

  editorTarget(moduleId: string, sourceId: string | null, line = 1, column = 1) {
    const module = this.#modules.get(moduleId);
    if (!module) return null;
    const selected = sourceId ? this.#files.get(sourceId) : null;
    const resource = isAbsolute(selected?.path ?? "")
      ? selected?.path
      : String(module.resource ?? "").split("?", 1)[0];
    if (!resource || !isAbsolute(resource)) return null;
    return {
      path: resource,
      line: Math.max(1, Math.trunc(line || 1)),
      column: Math.max(1, Math.trunc(column || 1)),
    };
  }
}

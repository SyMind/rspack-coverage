import { extname, isAbsolute } from "node:path";
import { sourceFileCoverageSpans } from "../shared/codeCoverage.js";
import { emptyMetrics, finalizeMetrics, metricsForModuleInstance } from "../shared/metrics.js";
import { normalizeSourcePath } from "../shared/path.js";
import type {
  BuildModule,
  BuildReference,
  BuildReferenceStore,
  BuildSnapshot,
  CodeViewResponse,
  CoverageReport,
  ModuleInvestigationDetail,
  ModuleReferencesResponse,
  ReferenceLocation,
  ReferenceSnippetResponse,
  SourceFileReport,
  SourceFileSummary,
  SourceLineState,
  UsageMetrics,
} from "../shared/types.js";
import { createInMemoryReferenceStore } from "./referenceStore.js";

const DEFAULT_CODE_LIMIT = 240_000;

function normalizeBuildSourcePath(value: string, context: string): string {
  const source = normalizeSourcePath(value);
  const normalizedContext = normalizeSourcePath(context);
  if (source === normalizedContext) return source.split("/").at(-1) ?? source;
  if (source.startsWith(`${normalizedContext}/`)) return source.slice(normalizedContext.length + 1);
  return source;
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

export class InvestigationModel {
  readonly summary: CoverageReport | null;
  readonly #modules: Map<string, BuildModule>;
  readonly #files = new Map<string, SourceFileSummary>();
  readonly #filesByModule = new Map<string, SourceFileSummary[]>();
  readonly #referenceStore: BuildReferenceStore;
  readonly #entryPathCache = new Map<string, BuildModule[]>();

  #cacheEntryPath(moduleId: string, path: BuildModule[]): void {
    this.#entryPathCache.delete(moduleId);
    this.#entryPathCache.set(moduleId, path);
    while (this.#entryPathCache.size > 128) {
      const oldest = this.#entryPathCache.keys().next().value;
      if (oldest === undefined) break;
      this.#entryPathCache.delete(oldest);
    }
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
    };
  }

  snippet(referenceId: string, _contextLines = 3): ReferenceSnippetResponse | null {
    const edge = this.#referenceStore.get(referenceId);
    if (!edge) return null;
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
    const detailedOrigin = origin
      ? (this.#filesForModule(origin.id)
          .map((file) => this.source(file.id))
          .find((file) => file?.content === content) ?? null)
      : null;
    const filename = normalizeBuildSourcePath(selected.path, this.snapshot.manifest.context);
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

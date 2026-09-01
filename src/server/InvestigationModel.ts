import { extname, isAbsolute } from "node:path";
import {
  type CoverageLineEvidence,
  type MatchedCoverage,
  materializeSourceFile,
} from "../analyzer/analyze.js";
import { intersectRanges } from "../analyzer/ranges.js";
import { buildGeneratedSpans, type GeneratedSpan } from "../analyzer/sourceMap.js";
import { sourceFileCoverageSpans, sourceLineCoverageStatus } from "../shared/codeCoverage.js";
import { addMetrics, emptyMetrics, finalizeMetrics } from "../shared/metrics.js";
import { normalizeSourcePath } from "../shared/path.js";
import type {
  BuildModule,
  BuildReference,
  BuildSnapshot,
  CodeCoverageSpan,
  CodeViewResponse,
  CoverageReport,
  ModuleInvestigationDetail,
  ModuleReferencesResponse,
  ReferenceSnippetResponse,
  SourceFileReport,
  UsageMetrics,
} from "../shared/types.js";

const DEFAULT_CODE_LIMIT = 240_000;

function normalizeBuildSourcePath(value: string, context: string): string {
  const source = normalizeSourcePath(value);
  const normalizedContext = normalizeSourcePath(context);
  if (source === normalizedContext) return source.split("/").at(-1) ?? source;
  if (source.startsWith(`${normalizedContext}/`)) return source.slice(normalizedContext.length + 1);
  return source;
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function mergeSpans(spans: CodeCoverageSpan[]): CodeCoverageSpan[] {
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
  matched: MatchedCoverage | undefined,
): CodeCoverageSpan[] {
  if (!matched) return [{ start, end, status: "unloaded" }];
  const executed = intersectRanges(matched.ranges, start, end);
  const parts: CodeCoverageSpan[] = [];
  let cursor = start;
  for (const range of executed) {
    if (range.start > cursor) parts.push({ start: cursor, end: range.start, status: "unexecuted" });
    if (range.end > range.start)
      parts.push({ start: range.start, end: range.end, status: "executed" });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < end) parts.push({ start: cursor, end, status: "unexecuted" });
  return parts;
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
  const content = response.content.slice(offset, endOffset);
  const spans = response.spans
    .filter((span) => span.end > offset && span.start < endOffset)
    .map((span) => ({
      ...span,
      start: Math.max(0, span.start - offset),
      end: Math.min(endOffset, span.end) - offset,
    }));
  return {
    ...response,
    content,
    spans,
    offset,
    endOffset,
    startLine: response.content.slice(0, offset).split("\n").length,
    totalCharacters,
    hasPrevious: offset > 0,
    hasNext: endOffset < totalCharacters,
  };
}

function emptyCode(
  view: "source" | "output",
  filename: string,
  sourceId: string | null,
  gap: string,
): CodeViewResponse {
  return sliceCode(
    {
      view,
      sourceId,
      filename,
      language: extname(filename).slice(1) || "javascript",
      content: "",
      spans: [],
      provenance: "unavailable",
      gap,
    },
    0,
    DEFAULT_CODE_LIMIT,
  );
}

function compactReport(report: CoverageReport): CoverageReport {
  return {
    ...report,
    files: report.files.map((file) => ({ ...file, content: null, lines: [] })),
  };
}

export class InvestigationModel {
  readonly report: CoverageReport;
  readonly summary: CoverageReport;
  readonly #modules: Map<string, BuildModule>;
  readonly #files: Map<string, SourceFileReport>;
  readonly #filesByModule = new Map<string, SourceFileReport[]>();
  readonly #references: Map<string, BuildReference>;
  readonly #incoming = new Map<string, string[]>();
  readonly #outgoing = new Map<string, string[]>();
  readonly #generatedSpans = new Map<string, GeneratedSpan[]>();
  readonly #entryPathCache = new Map<string, BuildModule[]>();
  readonly #materializedFiles = new Map<string, SourceFileReport>();

  constructor(
    readonly snapshot: BuildSnapshot,
    report: CoverageReport,
    readonly matched: Map<string, MatchedCoverage>,
    readonly lineEvidence: CoverageLineEvidence = new Map(),
    readonly analyzedAssetIds: ReadonlySet<string> = new Set(),
  ) {
    this.report = report;
    this.summary = compactReport(report);
    this.#modules = new Map(snapshot.manifest.modules.map((module) => [module.id, module]));
    this.#files = new Map(report.files.map((file) => [file.id, file]));
    for (const file of report.files) {
      for (const moduleId of file.moduleIds) {
        const files = this.#filesByModule.get(moduleId) ?? [];
        files.push(file);
        this.#filesByModule.set(moduleId, files);
      }
    }
    this.#references = new Map(snapshot.references.map((reference) => [reference.id, reference]));
    for (const reference of snapshot.references) {
      const incoming = this.#incoming.get(reference.targetId) ?? [];
      incoming.push(reference.id);
      this.#incoming.set(reference.targetId, incoming);
      const outgoing = this.#outgoing.get(reference.originId) ?? [];
      outgoing.push(reference.id);
      this.#outgoing.set(reference.originId, outgoing);
    }
  }

  source(fileId: string): SourceFileReport | null {
    const cached = this.#materializedFiles.get(fileId);
    if (cached) return cached;
    const file = this.#files.get(fileId);
    if (!file) return null;
    const materialized = materializeSourceFile(
      file,
      this.lineEvidence.get(file.path),
      this.snapshot.manifest,
      this.analyzedAssetIds,
    );
    this.#materializedFiles.set(fileId, materialized);
    return materialized;
  }

  #filesForModule(moduleId: string): SourceFileReport[] {
    const module = this.#modules.get(moduleId);
    if (!module) return [];
    const direct = this.#filesByModule.get(moduleId) ?? [];
    if (direct.length || !module.resource) return direct;
    const resource = normalizeBuildSourcePath(module.resource, this.snapshot.manifest.context);
    return this.report.files.filter(
      (file) =>
        file.path === resource ||
        file.path.endsWith(`/${resource}`) ||
        resource.endsWith(`/${file.path}`),
    );
  }

  #moduleMetrics(moduleId: string): UsageMetrics {
    const metrics = emptyMetrics();
    for (const file of this.#filesForModule(moduleId)) addMetrics(metrics, file.metrics);
    return finalizeMetrics(metrics);
  }

  #codeGeneration(moduleId: string) {
    const cached = this.snapshot.codeGeneration.get(moduleId);
    if (cached) return cached;
    return this.snapshot.loadCodeGeneration?.(moduleId) ?? [];
  }

  module(moduleId: string): ModuleInvestigationDetail | null {
    const module = this.#modules.get(moduleId);
    if (!module) return null;
    const files = this.#filesForModule(moduleId);
    const metrics = this.#moduleMetrics(moduleId);
    const source = files.some((file) => Boolean(file.content));
    const codeGeneration = this.#codeGeneration(moduleId).length > 0;
    const hasMappedOutput = metrics.mappedBytes > 0;
    const finalAsset = hasMappedOutput;
    const output = finalAsset || codeGeneration;
    return {
      ...module,
      sources: files.map((file) => ({
        id: file.id,
        name: file.path,
        mappedBytes: file.metrics.mappedBytes,
        loadedBytes: file.metrics.loadedBytes,
        executedBytes: file.metrics.executedBytes,
      })),
      metrics,
      incomingReferences: this.#incoming.get(moduleId)?.length ?? 0,
      outgoingReferences: this.#outgoing.get(moduleId)?.length ?? 0,
      views: {
        source,
        output,
        finalAsset,
        codeGeneration,
        hasMappedOutput,
        preferred: !hasMappedOutput && output ? "output" : source ? "source" : "output",
        outputKind: finalAsset ? "final-asset" : codeGeneration ? "module-code-generation" : null,
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
    if (view === "output") return this.#outputCode(module, offset, limit);
    const files = this.#filesForModule(moduleId);
    const selected = files.find((candidate) => candidate.id === sourceId) ?? files[0];
    const file = selected ? this.source(selected.id) : null;
    if (!file?.content) {
      return emptyCode(
        "source",
        file?.path ?? module.name,
        file?.id ?? null,
        "Source content is unavailable",
      );
    }
    return sliceCode(
      {
        view: "source",
        sourceId: file.id,
        filename: file.path,
        language: extname(file.path).slice(1) || "javascript",
        content: file.content,
        spans: sourceFileCoverageSpans(file),
        provenance: "final-source-map / captured-original-source",
        gap: null,
      },
      offset,
      limit,
    );
  }

  #assetSpans(assetId: string, content: string): GeneratedSpan[] {
    const cached = this.#generatedSpans.get(assetId);
    if (cached) return cached;
    const map = this.snapshot.maps.get(assetId);
    const spans = map ? buildGeneratedSpans(content, map) : [];
    this.#generatedSpans.set(assetId, spans);
    return spans;
  }

  #outputCode(module: BuildModule, offset: number, limit: number): CodeViewResponse {
    const files = this.#filesForModule(module.id);
    const paths = new Set(files.map((file) => file.path));
    const byAsset = new Map<string, Array<{ start: number; end: number }>>();
    const assetCandidates = this.snapshot.manifest.assets.filter(
      (asset) =>
        module.chunks.length === 0 || asset.chunks.some((chunk) => module.chunks.includes(chunk)),
    );
    for (const asset of assetCandidates) {
      const buffer = this.snapshot.assets.get(asset.id);
      if (!buffer || !asset.mapAvailable) continue;
      const content = buffer.toString("utf8");
      for (const span of this.#assetSpans(asset.id, content)) {
        if (!span.source) continue;
        const source = normalizeBuildSourcePath(span.source, this.snapshot.manifest.context);
        if (!paths.has(source)) continue;
        const values = byAsset.get(asset.id) ?? [];
        values.push({ start: span.start, end: span.end });
        byAsset.set(asset.id, values);
      }
    }

    let content = "";
    const coverageSpans: CodeCoverageSpan[] = [];
    for (const [assetId, segments] of byAsset) {
      const asset = this.snapshot.manifest.assets.find((candidate) => candidate.id === assetId);
      const generated = this.snapshot.assets.get(assetId)?.toString("utf8");
      if (!asset || !generated) continue;
      const groups: Array<{ start: number; end: number }> = [];
      for (const segment of [...segments].sort(
        (left, right) => left.start - right.start || left.end - right.end,
      )) {
        const previous = groups.at(-1);
        if (previous && segment.start - previous.end <= 160)
          previous.end = Math.max(previous.end, segment.end);
        else groups.push({ ...segment });
      }
      for (const group of groups) {
        const start = Math.max(0, group.start - 120);
        const end = Math.min(generated.length, group.end + 120);
        content += `${content ? "\n\n" : ""}// ── ${asset.name}:${start}-${end} ──\n`;
        const base = content.length;
        content += generated.slice(start, end);
        for (const part of coverageParts(start, end, this.matched.get(assetId))) {
          coverageSpans.push({
            ...part,
            start: base + part.start - start,
            end: base + part.end - start,
          });
        }
      }
    }

    let provenance = "final-generated-asset";
    let gap: string | null = null;
    if (!content) {
      const codeGeneration = this.#codeGeneration(module.id)[0];
      if (codeGeneration) {
        content = codeGeneration.content;
        coverageSpans.push({ start: 0, end: content.length, status: "unknown" });
        provenance = "module-code-generation";
        gap =
          "No generated characters map back to this module. Showing Rspack module code generation; runtime execution cannot be joined to an exact final-asset interval.";
      }
    }
    if (!content) {
      return emptyCode(
        "output",
        `${module.name} · generated output`,
        null,
        "No final-asset mapping or module code-generation source is available",
      );
    }
    return sliceCode(
      {
        view: "output",
        sourceId: null,
        filename: `${module.name} · ${provenance === "final-generated-asset" ? "final asset" : "code generation"}`,
        language: "javascript",
        content,
        spans: mergeSpans(coverageSpans),
        provenance,
        gap,
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
        this.#entryPathCache.set(moduleId, result);
        return result;
      }
      if (!currentId) continue;
      for (const referenceId of this.#incoming.get(currentId) ?? []) {
        const consumer = this.#references.get(referenceId)?.originId;
        if (!consumer || visited.has(consumer)) continue;
        visited.add(consumer);
        queue.push([...path, consumer]);
      }
      if (visited.size > 100_000) break;
    }
    this.#entryPathCache.set(moduleId, []);
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
    const ids =
      direction === "in"
        ? (this.#incoming.get(moduleId) ?? [])
        : direction === "out"
          ? (this.#outgoing.get(moduleId) ?? [])
          : [
              ...new Set([
                ...(this.#incoming.get(moduleId) ?? []),
                ...(this.#outgoing.get(moduleId) ?? []),
              ]),
            ];
    const safeCursor = Math.max(0, Math.trunc(cursor || 0));
    const safeLimit = Math.max(1, Math.min(250, Math.trunc(limit || 80)));
    const page = ids.slice(safeCursor, safeCursor + safeLimit);
    return {
      module,
      direction,
      total: ids.length,
      cursor: safeCursor,
      nextCursor: safeCursor + page.length < ids.length ? safeCursor + page.length : null,
      edges: page.flatMap((id) => {
        const edge = this.#references.get(id);
        if (!edge) return [];
        const origin = this.#modules.get(edge.originId);
        const target = this.#modules.get(edge.targetId);
        return origin && target ? [{ ...edge, origin, target }] : [];
      }),
      entryPath: this.entryPath(moduleId),
    };
  }

  snippet(referenceId: string, contextLines = 3): ReferenceSnippetResponse | null {
    const edge = this.#references.get(referenceId);
    if (!edge) return null;
    const origin = this.#modules.get(edge.originId);
    const rawFile = origin
      ? this.#filesForModule(origin.id).find((candidate) => candidate.content)
      : null;
    const file = rawFile ? this.source(rawFile.id) : null;
    if (!origin || !file?.content || !edge.location) {
      return {
        edge,
        available: false,
        gap: !file?.content
          ? "Consumer source is unavailable"
          : "Reference location is unavailable",
      };
    }
    const sourceLines = file.content.split("\n");
    const startLine = Math.max(1, edge.location.start.line - Math.max(0, contextLines));
    const endLine = Math.min(
      sourceLines.length,
      edge.location.end.line + Math.max(0, contextLines),
    );
    const content = sourceLines.slice(startLine - 1, endLine).join("\n");
    const starts = lineStarts(content);
    const relativeStartLine = edge.location.start.line - startLine;
    const relativeEndLine = edge.location.end.line - startLine;
    const highlightStart = (starts[relativeStartLine] ?? 0) + edge.location.start.column;
    const highlightEnd = Math.max(
      highlightStart + 1,
      (starts[relativeEndLine] ?? highlightStart) + edge.location.end.column,
    );
    const sourceLine = file.lines[edge.location.start.line - 1];
    return {
      edge,
      available: true,
      gap: null,
      filename: file.path,
      startLine,
      endLine,
      content,
      highlight: {
        start: Math.min(content.length, highlightStart),
        end: Math.min(content.length, highlightEnd),
        coverageStatus: sourceLine ? sourceLineCoverageStatus(sourceLine) : "unknown",
      },
      coverage: this.#moduleMetrics(origin.id),
      location: edge.location,
    };
  }

  aiContext(moduleId: string): unknown | null {
    const module = this.module(moduleId);
    if (!module) return null;
    return {
      schemaVersion: 1,
      kind: "rspack-module-coverage-ai-context",
      evidenceBoundary:
        "Runtime coverage describes only this imported recording and does not prove that code is removable.",
      build: {
        hash: this.snapshot.manifest.hash,
        mode: this.snapshot.manifest.mode,
        counts: this.snapshot.manifest.counts,
      },
      module,
      references: this.references(moduleId, "both", 0, 30),
      sourceExcerpt: this.code(moduleId, "source", module.sources[0]?.id ?? null, 0, 12_000),
      outputExcerpt: this.code(moduleId, "output", null, 0, 12_000),
      evidenceGaps: this.evidenceGaps(),
    };
  }

  evidenceGaps(): Array<{ kind: string; message: string }> {
    const gaps: Array<{ kind: string; message: string }> = this.snapshot.manifest.diagnostics.map(
      (diagnostic) => ({
        kind: diagnostic.severity,
        message: diagnostic.message,
      }),
    );
    const missingMaps = this.snapshot.manifest.assets.filter((asset) => !asset.mapAvailable);
    if (missingMaps.length) {
      gaps.push({
        kind: "source-map",
        message: `${missingMaps.length} JavaScript asset(s) have no usable column-level source map. Their source attribution remains unknown.`,
      });
    }
    const deferredMaps = this.snapshot.manifest.assets.filter(
      (asset) => asset.mapAvailable && !this.analyzedAssetIds.has(asset.id),
    );
    if (deferredMaps.length) {
      gaps.push({
        kind: "deferred-source-attribution",
        message: `${deferredMaps.length} emitted JavaScript asset(s) were not present in this recording. Their not-loaded byte total is exact, while source/module attribution remains unknown in the initial report so unloaded maps are not decoded eagerly.`,
      });
    }
    if (this.report.importSummary.precision !== "per-block") {
      gaps.push({
        kind: "coverage-precision",
        message: `Coverage precision is ${this.report.importSummary.precision}; record JavaScript Per block for code-range decisions.`,
      });
    }
    for (const ignored of this.report.importSummary.ignoredEntries.slice(0, 25)) {
      gaps.push({ kind: "ignored-coverage-entry", message: `${ignored.url}: ${ignored.reason}` });
    }
    return gaps;
  }

  editorTarget(moduleId: string, sourceId: string | null, line = 1, column = 1) {
    const module = this.#modules.get(moduleId);
    if (!module) return null;
    const selected = sourceId ? this.#files.get(sourceId) : null;
    const selectedPath = selected?.path ?? "";
    const resource = isAbsolute(selectedPath)
      ? selectedPath
      : String(module.resource ?? "").split("?", 1)[0];
    if (!resource || !isAbsolute(resource)) return null;
    return {
      path: resource,
      line: Math.max(1, Math.trunc(line || 1)),
      column: Math.max(1, Math.trunc(column || 1)),
    };
  }
}

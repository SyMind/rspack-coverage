import { addMetrics, emptyMetrics, finalizeMetrics, metricsFromBytes } from "../shared/metrics.js";
import { normalizeSourcePath, normalizeUrlPath, sourceCategory } from "../shared/path.js";
import type {
  BuildAsset,
  BuildManifest,
  ChromeCoverageEntry,
  ChromeCoverageRange,
  ChunkReport,
  CoverageImportSummary,
  CoverageReport,
  Opportunity,
  RawSourceMapPayload,
  RuntimeState,
  SourceFileReport,
  SourceLineState,
  TreeNodeReport,
  UsageMetrics,
} from "../shared/types.js";
import { intersectRanges, mergeRanges } from "./ranges.js";
import { buildGeneratedSpans } from "./sourceMap.js";
import { buildUtf8Prefix, splitSourceLines, utf8BytesBetween } from "./utf.js";

export interface MatchedCoverage {
  asset: BuildAsset;
  text: string;
  ranges: ChromeCoverageRange[];
}

export type AnalysisCollection<T> = Record<string, T> | ReadonlyMap<string, T>;

export interface CoverageAnalysisInput {
  build: BuildManifest;
  coverage: ChromeCoverageEntry[];
  maps: AnalysisCollection<RawSourceMapPayload>;
  generatedAssets: AnalysisCollection<string | Uint8Array>;
  originalSources: AnalysisCollection<string>;
  precision: CoverageImportSummary["precision"];
  onProgress?: (phase: string, completed: number, total: number) => void;
}

export interface CoverageAnalysisResult {
  report: CoverageReport;
  matched: Map<string, MatchedCoverage>;
  lineEvidence: CoverageLineEvidence;
  analyzedAssetIds: ReadonlySet<string>;
}

export interface CoverageLineEvidenceItem {
  emittedBytes: number;
  loadedBytes: number;
  executedBytes: number;
  chunks: ReadonlySet<string>;
}

export type CoverageLineEvidence = ReadonlyMap<
  string,
  ReadonlyMap<number, CoverageLineEvidenceItem>
>;

function collectionGet<T>(collection: AnalysisCollection<T>, key: string): T | undefined {
  return typeof (collection as ReadonlyMap<string, T>).get === "function"
    ? (collection as ReadonlyMap<string, T>).get(key)
    : (collection as Record<string, T>)[key];
}

function collectionEntries<T>(collection: AnalysisCollection<T>): Array<[string, T]> {
  return typeof (collection as ReadonlyMap<string, T>).entries === "function"
    ? [...(collection as ReadonlyMap<string, T>).entries()]
    : Object.entries(collection as Record<string, T>);
}

function generatedText(value: string | Uint8Array | undefined): string | undefined {
  if (typeof value === "string") return value;
  return value ? new TextDecoder().decode(value) : undefined;
}

interface MutableLine {
  emittedBytes: number;
  loadedBytes: number;
  executedBytes: number;
  chunks: Set<string>;
}

interface MutableFile {
  path: string;
  content: string | null;
  metrics: UsageMetrics;
  chunks: Set<string>;
  loadedChunks: Set<string>;
  lines: Map<number, MutableLine>;
}

async function contentHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 20);
}

function pathMatches(entryUrl: string, asset: BuildAsset): boolean {
  const entryPath = normalizeUrlPath(entryUrl);
  const assetPath = normalizeUrlPath(asset.urlPath);
  const plainName = `/${asset.name.replace(/^\/+/, "")}`;
  return entryPath === assetPath || entryPath === plainName || entryPath.endsWith(plainName);
}

export async function matchCoverage(
  build: BuildManifest,
  coverage: ChromeCoverageEntry[],
): Promise<{
  matched: Map<string, MatchedCoverage>;
  ignored: CoverageImportSummary["ignoredEntries"];
}> {
  const matched = new Map<string, MatchedCoverage>();
  const ignored: CoverageImportSummary["ignoredEntries"] = [];

  for (const entry of coverage) {
    if (
      !entry ||
      typeof entry.url !== "string" ||
      typeof entry.text !== "string" ||
      !Array.isArray(entry.ranges)
    ) {
      ignored.push({
        url: String(entry?.url ?? "[invalid entry]"),
        reason: "Invalid Coverage entry",
      });
      continue;
    }
    const candidates = build.assets.filter((asset) => pathMatches(entry.url, asset));
    if (candidates.length === 0) {
      ignored.push({ url: entry.url, reason: "Not a JavaScript asset from this build" });
      continue;
    }
    const hash = await contentHash(entry.text);
    const asset = candidates.find(
      (candidate) =>
        candidate.contentHash === hash &&
        candidate.size === new TextEncoder().encode(entry.text).byteLength,
    );
    if (!asset) {
      throw new Error(
        `Coverage for ${entry.url} does not match build ${build.hash}. Rebuild, reload the local preview, and record Coverage again.`,
      );
    }
    const previous = matched.get(asset.id);
    if (previous && previous.text !== entry.text) {
      throw new Error(`Coverage contains conflicting generated text for ${asset.name}.`);
    }
    const ranges = mergeRanges([...(previous?.ranges ?? []), ...entry.ranges], entry.text.length);
    matched.set(asset.id, { asset, text: entry.text, ranges });
  }
  return { matched, ignored };
}

function runtimeState(line: { loadedBytes: number; executedBytes: number }): RuntimeState {
  if (line.loadedBytes === 0) return "not-loaded";
  return line.executedBytes > 0 ? "executed" : "not-executed";
}

function mutableFile(
  files: Map<string, MutableFile>,
  path: string,
  content: string | null,
): MutableFile {
  const existing = files.get(path);
  if (existing) {
    if (content !== null) existing.content = content;
    return existing;
  }
  const created: MutableFile = {
    path,
    content,
    metrics: emptyMetrics(),
    chunks: new Set(),
    loadedChunks: new Set(),
    lines: new Map(),
  };
  files.set(path, created);
  return created;
}

function normalizeBuildSourcePath(value: string, context: string): string {
  const source = normalizeSourcePath(value);
  const normalizedContext = normalizeSourcePath(context);
  if (source === normalizedContext) return source.split("/").at(-1) ?? source;
  if (source.startsWith(`${normalizedContext}/`)) return source.slice(normalizedContext.length + 1);
  return source;
}

function addLineBytes(
  file: MutableFile,
  lineNumber: number,
  input: {
    emitted: number;
    loaded: number;
    executed: number;
    chunks: string[];
  },
): void {
  const line = file.lines.get(lineNumber) ?? {
    emittedBytes: 0,
    loadedBytes: 0,
    executedBytes: 0,
    chunks: new Set<string>(),
  };
  line.emittedBytes += input.emitted;
  line.loadedBytes += input.loaded;
  line.executedBytes += input.executed;
  for (const chunk of input.chunks) line.chunks.add(chunk);
  file.lines.set(lineNumber, line);
}

interface ModuleSourceIndex {
  exact: Map<string, string[]>;
  suffix: Map<string, string[]>;
}

function appendModuleIndex(index: Map<string, string[]>, key: string, moduleId: string): void {
  const ids = index.get(key) ?? [];
  if (!ids.includes(moduleId)) ids.push(moduleId);
  index.set(key, ids);
}

function buildModuleSourceIndex(build: BuildManifest): ModuleSourceIndex {
  const exact = new Map<string, string[]>();
  const suffix = new Map<string, string[]>();
  for (const module of build.modules) {
    if (!module.resource) continue;
    const resource = normalizeBuildSourcePath(module.resource, build.context);
    appendModuleIndex(exact, resource, module.id);
    const parts = resource.split("/").filter(Boolean);
    for (let index = 0; index < parts.length; index += 1) {
      appendModuleIndex(suffix, parts.slice(index).join("/"), module.id);
    }
  }
  return { exact, suffix };
}

function moduleIdsForSource(
  build: BuildManifest,
  sourceIndex: ModuleSourceIndex,
  sourcePath: string,
): string[] {
  const normalizedSource = normalizeBuildSourcePath(sourcePath, build.context);
  const matches = new Set([
    ...(sourceIndex.exact.get(normalizedSource) ?? []),
    ...(sourceIndex.suffix.get(normalizedSource) ?? []),
  ]);
  const parts = normalizedSource.split("/").filter(Boolean);
  for (let index = 1; index < parts.length; index += 1) {
    for (const moduleId of sourceIndex.exact.get(parts.slice(index).join("/")) ?? []) {
      matches.add(moduleId);
    }
  }
  return [...matches];
}

function toFileReports(files: Map<string, MutableFile>, build: BuildManifest): SourceFileReport[] {
  const sourceIndex = buildModuleSourceIndex(build);
  const chunksByModule = new Map(build.modules.map((module) => [module.id, module.chunks]));
  return [...files.values()]
    .map((file) => {
      finalizeMetrics(file.metrics);
      const moduleIds = moduleIdsForSource(build, sourceIndex, file.path);
      const moduleChunks = moduleIds.flatMap((moduleId) => chunksByModule.get(moduleId) ?? []);
      const chunks = [...new Set([...file.chunks, ...moduleChunks])];
      const loadedChunks = [...file.loadedChunks];
      return {
        id: file.path,
        path: file.path,
        displayPath: file.path,
        category: sourceCategory(file.path),
        metrics: file.metrics,
        chunks,
        loadedChunks,
        moduleIds,
        duplicated: new Set(loadedChunks).size > 1,
        content: file.content,
        lines: [],
      } satisfies SourceFileReport;
    })
    .sort((a, b) => b.metrics.unusedBytes - a.metrics.unusedBytes || a.path.localeCompare(b.path));
}

export function materializeSourceFile(
  file: SourceFileReport,
  evidence: ReadonlyMap<number, CoverageLineEvidenceItem> | undefined,
  build: BuildManifest,
  analyzedAssetIds: ReadonlySet<string>,
): SourceFileReport {
  if (file.lines.length > 0 || file.content === null) return file;
  const sourceLines = splitSourceLines(file.content);
  const maxMappedLine = Math.max(-1, ...(evidence?.keys() ?? []));
  // sourcesContent is authoritative. A malformed map must not manufacture
  // thousands of empty rows beyond the actual captured source.
  const lineCount = file.content === null ? maxMappedLine + 1 : sourceLines.length;
  const relevantAssets = build.assets.filter(
    (asset) =>
      file.chunks.length === 0 || asset.chunks.some((chunk) => file.chunks.includes(chunk)),
  );
  const canProveAbsence =
    relevantAssets.length > 0 &&
    relevantAssets.every((asset) => asset.mapAvailable && analyzedAssetIds.has(asset.id));
  const lines: SourceLineState[] = [];
  for (let index = 0; index < lineCount; index += 1) {
    const mapped = evidence?.get(index);
    const text = sourceLines[index] ?? "";
    const lineRuntimeState = mapped ? runtimeState(mapped) : "not-loaded";
    lines.push({
      line: index + 1,
      text,
      buildState: mapped?.emittedBytes
        ? "retained"
        : text.trim() && canProveAbsence
          ? "not-emitted"
          : "unknown",
      runtimeState: lineRuntimeState,
      emittedBytes: mapped?.emittedBytes ?? 0,
      executedBytes: mapped?.executedBytes ?? 0,
      chunks: mapped ? [...mapped.chunks] : file.chunks,
      ranges:
        mapped?.loadedBytes && text.length
          ? [
              {
                startColumn: 0,
                endColumn: text.length,
                executed: lineRuntimeState === "executed" || lineRuntimeState === "partial",
              },
            ]
          : [],
    });
  }
  return { ...file, lines };
}

function buildTree(files: SourceFileReport[]): TreeNodeReport {
  const root: TreeNodeReport = {
    id: "root",
    name: "Sources",
    path: "",
    kind: "root",
    category: "all",
    metrics: emptyMetrics(),
    chunks: [],
    duplicated: false,
    children: [],
  };

  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let parent = root;
    let currentPath = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index] ?? "[unknown]";
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      let child = parent.children.find((item) => item.kind === "directory" && item.name === part);
      if (!child) {
        child = {
          id: `dir:${currentPath}`,
          name: part,
          path: currentPath,
          kind: "directory",
          category: file.category,
          metrics: emptyMetrics(),
          chunks: [],
          duplicated: false,
          children: [],
        };
        parent.children.push(child);
      } else if (child.category !== file.category) {
        child.category = "mixed";
      }
      parent = child;
    }
    parent.children.push({
      id: `file:${file.id}`,
      name: parts.at(-1) ?? file.path,
      path: file.path,
      kind: "file",
      category: file.category,
      metrics: { ...file.metrics },
      chunks: file.chunks,
      duplicated: file.duplicated,
      fileId: file.id,
      children: [],
    });
  }

  const aggregate = (
    node: TreeNodeReport,
  ): { metrics: UsageMetrics; chunks: Set<string>; categories: Set<string> } => {
    if (node.kind === "file") {
      return {
        metrics: node.metrics,
        chunks: new Set(node.chunks),
        categories: new Set([node.category]),
      };
    }
    const metrics = emptyMetrics();
    const chunks = new Set<string>();
    const categories = new Set<string>();
    for (const child of node.children) {
      const result = aggregate(child);
      addMetrics(metrics, result.metrics);
      for (const chunk of result.chunks) chunks.add(chunk);
      for (const category of result.categories) categories.add(category);
    }
    node.metrics = finalizeMetrics(metrics);
    node.chunks = [...chunks];
    node.duplicated = node.children.some((child) => child.duplicated);
    node.category =
      node.kind === "root"
        ? "all"
        : categories.size === 1
          ? (categories.values().next().value as any)
          : "mixed";
    node.children.sort(
      (a, b) => b.metrics.unusedBytes - a.metrics.unusedBytes || a.name.localeCompare(b.name),
    );
    return { metrics: node.metrics, chunks, categories };
  };
  aggregate(root);
  return root;
}

function buildOpportunities(files: SourceFileReport[], chunks: ChunkReport[]): Opportunity[] {
  const opportunities: Opportunity[] = [];
  for (const file of files) {
    if (file.metrics.loadedBytes === 0) continue;
    if (file.metrics.unusedBytes >= 1024) {
      opportunities.push({
        id: `unused:${file.id}`,
        kind: "largest-unused",
        title: "Large loaded-but-unexecuted source",
        description:
          "This source contributed generated bytes to a loaded asset, but much of that generated code did not execute in this recording.",
        path: file.path,
        fileId: file.id,
        metrics: file.metrics,
        evidence: [
          `${file.metrics.unusedBytes} unused generated bytes`,
          `${file.loadedChunks.length} loaded chunk(s)`,
        ],
      });
    }
    if ((file.metrics.usageRatio ?? 1) < 0.25 && file.metrics.loadedBytes >= 10_000) {
      opportunities.push({
        id: `low:${file.id}`,
        kind: "low-usage",
        title: "Low runtime usage",
        description:
          "A large emitted contribution has low execution coverage in the imported user journey.",
        path: file.path,
        fileId: file.id,
        metrics: file.metrics,
        evidence: [`${Math.round((file.metrics.usageRatio ?? 0) * 100)}% byte usage`],
      });
    }
    if (file.duplicated) {
      opportunities.push({
        id: `duplicate:${file.id}`,
        kind: "duplicated",
        title: "Source appears in multiple loaded chunks",
        description:
          "Generated instances of the same original source are present in more than one loaded chunk.",
        path: file.path,
        fileId: file.id,
        metrics: file.metrics,
        evidence: file.loadedChunks.map((chunk) => `Loaded chunk ${chunk}`),
      });
    }
    if (
      /(?:locale|locales|schema|schemas|polyfill|icons?)(?:\/|\.|-)/i.test(file.path) &&
      file.metrics.loadedBytes >= 4096
    ) {
      opportunities.push({
        id: `collection:${file.id}`,
        kind: "collection",
        title: "Large collection-like source",
        description:
          "The path looks like a locale, schema, polyfill, or icon collection. Check whether narrower imports or lazy loading fit the product behavior.",
        path: file.path,
        fileId: file.id,
        metrics: file.metrics,
        evidence: ["Path-pattern signal only; verify source and runtime behavior"],
      });
    }
  }
  for (const chunk of chunks) {
    if (chunk.initial && chunk.loaded && chunk.metrics.unusedBytes >= 10_000) {
      opportunities.push({
        id: `initial:${chunk.id}`,
        kind: "initial-unused",
        title: "Initial chunk has substantial unexecuted code",
        description:
          "The initial chunk was loaded, while a substantial part of its generated bytes did not execute in this recording.",
        path: chunk.names[0] ?? `chunk ${chunk.id}`,
        chunkId: chunk.id,
        metrics: chunk.metrics,
        evidence: ["Initial chunk", `${chunk.metrics.unusedBytes} loaded-but-unexecuted bytes`],
      });
    }
  }
  return opportunities.sort((a, b) => b.metrics.unusedBytes - a.metrics.unusedBytes).slice(0, 100);
}

export async function analyzeCoverageWithMatches(
  input: CoverageAnalysisInput,
): Promise<CoverageAnalysisResult> {
  if (!Array.isArray(input.coverage)) throw new Error("Chrome Coverage JSON must be an array.");
  const { matched, ignored } = await matchCoverage(input.build, input.coverage);
  if (matched.size === 0) {
    throw new Error("No JavaScript assets in this Coverage file match the current build.");
  }

  const files = new Map<string, MutableFile>();
  for (const [source, content] of collectionEntries(input.originalSources)) {
    mutableFile(files, normalizeBuildSourcePath(source, input.build.context), content);
  }
  const globalMetrics = emptyMetrics();
  const assetMetrics = new Map<string, UsageMetrics>();
  const loadedChunkIds = new Set<string>();

  for (let index = 0; index < input.build.assets.length; index += 1) {
    const asset = input.build.assets[index] as BuildAsset;
    input.onProgress?.("Mapping generated code", index, input.build.assets.length);
    const coverage = matched.get(asset.id);
    const loaded = Boolean(coverage);
    if (!loaded) {
      // Keep the not-loaded byte total exact without claiming source attribution.
      // Decoding every unloaded source map makes large builds unusable; mapped and
      // unmapped evidence for those assets stays unknown until selected on demand.
      const metrics = finalizeMetrics({ ...emptyMetrics(), emittedBytes: asset.size });
      assetMetrics.set(asset.id, metrics);
      addMetrics(globalMetrics, metrics);
      continue;
    }
    const generated =
      coverage?.text ?? generatedText(collectionGet(input.generatedAssets, asset.id));
    const ranges = coverage?.ranges ?? [];
    const map = collectionGet(input.maps, asset.id);
    if (!generated) {
      const metrics = metricsFromBytes({
        emittedBytes: asset.size,
        loaded: false,
        executedBytes: 0,
        mapped: false,
      });
      assetMetrics.set(asset.id, metrics);
      addMetrics(globalMetrics, metrics);
      continue;
    }
    if (loaded) for (const chunk of asset.chunks) loadedChunkIds.add(chunk);
    const prefix = buildUtf8Prefix(generated);
    const spans = map
      ? buildGeneratedSpans(generated, map)
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
    const currentAssetMetrics = emptyMetrics();

    for (const span of spans) {
      const emittedBytes = utf8BytesBetween(prefix, span.start, span.end);
      if (emittedBytes === 0) continue;
      const used = loaded ? intersectRanges(ranges, span.start, span.end) : [];
      const executedBytes = used.reduce(
        (total, range) => total + utf8BytesBetween(prefix, range.start, range.end),
        0,
      );
      const metrics = metricsFromBytes({
        emittedBytes,
        loaded,
        executedBytes,
        mapped: span.source !== null,
      });
      addMetrics(currentAssetMetrics, metrics);

      const path = span.source
        ? normalizeBuildSourcePath(span.source, input.build.context)
        : `[rspack runtime / unmapped]/${asset.name}`;
      const file = mutableFile(files, path, span.sourceContent);
      addMetrics(file.metrics, metrics);
      for (const chunk of asset.chunks) {
        file.chunks.add(chunk);
        if (loaded) file.loadedChunks.add(chunk);
      }
      if (span.originalLine !== null) {
        addLineBytes(file, span.originalLine, {
          emitted: emittedBytes,
          loaded: loaded ? emittedBytes : 0,
          executed: executedBytes,
          chunks: asset.chunks,
        });
      }
    }
    assetMetrics.set(asset.id, finalizeMetrics(currentAssetMetrics));
    addMetrics(globalMetrics, currentAssetMetrics);
  }
  input.onProgress?.("Aggregating sources", input.build.assets.length, input.build.assets.length);

  const fileReports = toFileReports(files, input.build);
  const tree = buildTree(fileReports);
  const chunks: ChunkReport[] = input.build.chunks.map((chunk) => {
    const metrics = emptyMetrics();
    for (const file of chunk.files) {
      const asset = input.build.assets.find((candidate) => candidate.name === file);
      if (asset) addMetrics(metrics, assetMetrics.get(asset.id) ?? emptyMetrics());
    }
    return {
      ...chunk,
      loaded: loadedChunkIds.has(chunk.id),
      metrics: finalizeMetrics(metrics),
      duplicatedSources: fileReports.filter(
        (file) => file.duplicated && file.chunks.includes(chunk.id),
      ).length,
    };
  });

  const report: CoverageReport = {
    version: 1,
    buildHash: input.build.hash,
    createdAt: Date.now(),
    metrics: finalizeMetrics(globalMetrics),
    importSummary: {
      importedEntries: input.coverage.length,
      matchedAssets: matched.size,
      ignoredEntries: ignored,
      precision: input.precision,
    },
    tree,
    files: fileReports,
    chunks,
    opportunities: buildOpportunities(fileReports, chunks),
  };
  return {
    report,
    matched,
    lineEvidence: new Map([...files].map(([path, file]) => [path, file.lines] as const)),
    analyzedAssetIds: new Set(matched.keys()),
  };
}

export async function analyzeCoverage(input: CoverageAnalysisInput): Promise<CoverageReport> {
  const result = await analyzeCoverageWithMatches(input);
  result.report.files = result.report.files.map((file) =>
    materializeSourceFile(
      file,
      result.lineEvidence.get(file.path),
      input.build,
      result.analyzedAssetIds,
    ),
  );
  return result.report;
}

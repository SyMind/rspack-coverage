import { addMetrics, emptyMetrics, finalizeMetrics, metricsFromBytes } from "../shared/metrics.js";
import { normalizeSourcePathForContext, normalizeUrlPath, sourceCategory } from "../shared/path.js";
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
  SourceFileDetail,
  SourceFileSummary,
  SourceLineState,
  TreeNodeReport,
  UsageMetrics,
} from "../shared/types.js";
import { intersectRanges, mergeRanges } from "./ranges.js";
import { buildGeneratedSpans } from "./sourceMap.js";
import { buildLineStarts, buildUtf8Prefix, splitSourceLines, utf8BytesBetween } from "./utf.js";

export interface MatchedCoverage {
  asset: BuildAsset;
  text: string;
  ranges: ChromeCoverageRange[];
}

interface MutableLine {
  emittedBytes: number;
  loadedBytes: number;
  executedBytes: number;
  chunks: Set<string>;
  ranges: SourceLineState["ranges"];
  assets: Map<string, LineAssetEvidence>;
}

interface LineAssetEvidence {
  emittedBytes: number;
  loadedBytes: number;
  executedBytes: number;
  chunks: string[];
}

interface MutableFile {
  path: string;
  metrics: UsageMetrics;
  chunks: Set<string>;
  loadedChunks: Set<string>;
  lines: Map<number, MutableLine>;
}

interface IndexedSourceModule {
  id: string;
  chunks: string[];
  order: number;
  reversedResource: string;
}

interface SourceModuleIndex {
  byResource: Map<string, IndexedSourceModule[]>;
  byReversedResource: IndexedSourceModule[];
}

interface CapturedSourceContentIndex {
  /** normalized source path -> provider key */
  exact: Map<string, string>;
  /** normalized suffix -> unique provider key, or null when ambiguous */
  suffix: Map<string, string | null>;
}

interface StoredSourceLine {
  lineIndex: number;
  emittedBytes: number;
  loadedBytes: number;
  executedBytes: number;
  chunks: string[];
  ranges: SourceLineState["ranges"];
  moduleStates?: Record<
    string,
    { emittedBytes: number; loadedBytes: number; executedBytes: number }
  >;
}

export interface StoredSourceFileDetail {
  id: string;
  content: string | null;
  sourceMapAvailable: boolean;
  chunks: string[];
  mappedLines: StoredSourceLine[];
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
  build: Pick<BuildManifest, "hash" | "assets">,
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

function runtimeState(line: Pick<MutableLine, "loadedBytes" | "executedBytes">): RuntimeState {
  if (line.loadedBytes === 0) return "not-loaded";
  return line.executedBytes > 0 ? "executed" : "not-executed";
}

export function materializeSourceFileDetail(
  input: StoredSourceFileDetail,
  moduleId?: string | null,
): SourceFileDetail {
  const sourceLines = input.content === null ? [] : splitSourceLines(input.content);
  let maxMappedLine = -1;
  const mappedLines = new Map<number, StoredSourceLine>();
  for (const line of input.mappedLines) {
    maxMappedLine = Math.max(maxMappedLine, line.lineIndex);
    mappedLines.set(line.lineIndex, line);
  }
  // sourcesContent is authoritative for the source drawer. A malformed or
  // incompatible map must not manufacture thousands of empty source rows.
  const lineCount = input.content === null ? maxMappedLine + 1 : sourceLines.length;
  const lines: SourceLineState[] = [];
  for (let index = 0; index < lineCount; index += 1) {
    const mapped = mappedLines.get(index);
    const moduleState = moduleId ? mapped?.moduleStates?.[moduleId] : undefined;
    const evidence = mapped && moduleState ? { ...mapped, ...moduleState } : mapped;
    const text = sourceLines[index] ?? "";
    const lineRuntimeState = evidence ? runtimeState(evidence) : "not-loaded";
    lines.push({
      line: index + 1,
      text,
      buildState: mapped?.emittedBytes
        ? "retained"
        : text.trim() && input.sourceMapAvailable
          ? "not-emitted"
          : "unknown",
      runtimeState: lineRuntimeState,
      emittedBytes: evidence?.emittedBytes ?? 0,
      loadedBytes: evidence?.loadedBytes ?? 0,
      executedBytes: evidence?.executedBytes ?? 0,
      chunks: mapped?.chunks ?? input.chunks,
      ranges: mapped?.ranges.map((range) => ({ ...range })) ?? [],
    });
  }
  return { id: input.id, lines };
}

function mutableFile(files: Map<string, MutableFile>, path: string): MutableFile {
  const existing = files.get(path);
  if (existing) return existing;
  const created: MutableFile = {
    path,
    metrics: emptyMetrics(),
    chunks: new Set(),
    loadedChunks: new Set(),
    lines: new Map(),
  };
  files.set(path, created);
  return created;
}

function indexCapturedSourceContent(
  index: CapturedSourceContentIndex,
  path: string,
  sourceKey: string,
): void {
  index.exact.set(path, sourceKey);
  const parts = path.split("/").filter(Boolean);
  // A basename alone is not a stable source identity. Keep suffixes with at
  // least two path segments, and reject suffixes that resolve ambiguously.
  for (let offset = 0; offset < parts.length - 1; offset += 1) {
    const suffix = parts.slice(offset).join("/");
    const existing = index.suffix.get(suffix);
    if (existing === undefined) index.suffix.set(suffix, sourceKey);
    else if (existing !== sourceKey) index.suffix.set(suffix, null);
  }
}

function capturedSourceKey(index: CapturedSourceContentIndex, path: string): string | null {
  const exact = index.exact.get(path);
  if (exact !== undefined) return exact;
  const directSuffix = index.suffix.get(path);
  if (directSuffix !== undefined) return directSuffix;
  const parts = path.split("/").filter(Boolean);
  for (let offset = 1; offset < parts.length - 1; offset += 1) {
    const matched = index.suffix.get(parts.slice(offset).join("/"));
    if (matched !== undefined) return matched;
  }
  return null;
}

function addLineBytes(
  file: MutableFile,
  lineNumber: number,
  input: {
    emitted: number;
    loaded: number;
    executed: number;
    chunks: string[];
    assetId: string;
    startColumn: number;
    endColumn: number;
  },
): void {
  const line: MutableLine = file.lines.get(lineNumber) ?? {
    emittedBytes: 0,
    loadedBytes: 0,
    executedBytes: 0,
    chunks: new Set<string>(),
    ranges: [],
    assets: new Map(),
  };
  line.emittedBytes += input.emitted;
  line.loadedBytes += input.loaded;
  line.executedBytes += input.executed;
  const asset = line.assets.get(input.assetId) ?? {
    emittedBytes: 0,
    loadedBytes: 0,
    executedBytes: 0,
    chunks: input.chunks,
  };
  asset.emittedBytes += input.emitted;
  asset.loadedBytes += input.loaded;
  asset.executedBytes += input.executed;
  line.assets.set(input.assetId, asset);
  for (const chunk of input.chunks) line.chunks.add(chunk);
  if (input.loaded > 0) {
    line.ranges.push({
      startColumn: input.startColumn,
      endColumn: input.endColumn,
      executed: input.executed > 0,
    });
  }
  file.lines.set(lineNumber, line);
}

function pathSuffixes(path: string): string[] {
  const suffixes = [path];
  let separator = path.indexOf("/");
  while (separator !== -1) {
    const suffix = path.slice(separator + 1);
    if (suffix) suffixes.push(suffix);
    separator = path.indexOf("/", separator + 1);
  }
  return suffixes;
}

function appendIndexedModule(
  index: Map<string, IndexedSourceModule[]>,
  path: string,
  module: IndexedSourceModule,
): void {
  const modules = index.get(path);
  if (modules) modules.push(module);
  else index.set(path, [module]);
}

function reversePath(path: string): string {
  return path.split("/").reverse().join("/");
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function lowerBoundByReversedResource(modules: IndexedSourceModule[], value: string): number {
  let lower = 0;
  let upper = modules.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    const module = modules[middle] as IndexedSourceModule;
    if (compareText(module.reversedResource, value) < 0) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

function buildSourceModuleIndex(
  build: BuildManifest,
  onProgress?: (phase: string, completed: number, total: number) => void,
): SourceModuleIndex {
  const byResource = new Map<string, IndexedSourceModule[]>();
  const byReversedResource: IndexedSourceModule[] = [];
  let lastProgressAt = Date.now();
  onProgress?.("Indexing modules", 0, build.modules.length);

  for (let order = 0; order < build.modules.length; order += 1) {
    const module = build.modules[order];
    if (!module) continue;
    const ownedPaths = new Set(
      [module.resource, ...(module.sourcePaths ?? [])]
        .filter((path): path is string => Boolean(path))
        .map((path) => normalizeSourcePathForContext(path, build.context)),
    );
    for (const resource of ownedPaths) {
      const indexed = {
        id: module.id,
        chunks: module.chunks,
        order,
        reversedResource: reversePath(resource),
      };
      appendIndexedModule(byResource, resource, indexed);
      byReversedResource.push(indexed);
    }

    const now = Date.now();
    if (order === build.modules.length - 1 || now - lastProgressAt >= 100) {
      onProgress?.("Indexing modules", order + 1, build.modules.length);
      lastProgressAt = now;
    }
  }

  byReversedResource.sort(
    (a, b) => compareText(a.reversedResource, b.reversedResource) || a.order - b.order,
  );
  return { byResource, byReversedResource };
}

function modulesForSource(index: SourceModuleIndex, sourcePath: string): IndexedSourceModule[] {
  // Exact normalized resource identity is authoritative. Previously an exact
  // match was combined with every shorter suffix match, so `src/index.ts`
  // could inherit unrelated module instances ending in the same path.
  const exact = index.byResource.get(sourcePath);
  if (exact?.length) return [...exact].sort((a, b) => a.order - b.order);

  // If source-map and stats paths use different roots, use only the longest
  // suffix that resolves. Never merge progressively shorter suffixes.
  for (const suffix of pathSuffixes(sourcePath).slice(1)) {
    const suffixMatches = index.byResource.get(suffix);
    if (suffixMatches?.length) {
      return [...suffixMatches].sort((a, b) => a.order - b.order);
    }
  }

  const matches = new Map<number, IndexedSourceModule>();
  const reversedPrefix = `${reversePath(sourcePath)}/`;
  for (
    let moduleIndex = lowerBoundByReversedResource(index.byReversedResource, reversedPrefix);
    moduleIndex < index.byReversedResource.length;
    moduleIndex += 1
  ) {
    const module = index.byReversedResource[moduleIndex] as IndexedSourceModule;
    if (!module.reversedResource.startsWith(reversedPrefix)) break;
    matches.set(module.order, module);
  }

  return [...matches.values()].sort((a, b) => a.order - b.order);
}

function retainedSourceMetrics(
  file: MutableFile,
  content: string | null,
  moduleChunks?: ReadonlySet<string>,
): UsageMetrics | null {
  if (content === null) return null;
  const prefix = buildUtf8Prefix(content);
  const starts = buildLineStarts(content);
  const metrics = emptyMetrics();

  // The module view is source-oriented: a retained source line is counted
  // once, regardless of how much generated/minified code maps back to it or
  // how many assets contain a copy. Generated-byte evidence is used only to
  // classify that source line as loaded/executed. A line with any executed
  // generated range is counted as fully executed at source-line precision.
  for (const [lineIndex, line] of file.lines) {
    const { emittedBytes, loadedBytes, executedBytes } = lineEvidence(line, moduleChunks);
    if (emittedBytes <= 0) continue;
    const start = starts[lineIndex];
    if (start === undefined) continue;
    const end = starts[lineIndex + 1] ?? content.length;
    const sourceBytes = utf8BytesBetween(prefix, start, end);
    if (sourceBytes === 0) continue;

    metrics.emittedBytes += sourceBytes;
    metrics.mappedBytes += sourceBytes;
    if (loadedBytes <= 0) continue;
    metrics.loadedBytes += sourceBytes;
    if (executedBytes <= 0) continue;
    metrics.executedBytes += sourceBytes;
  }
  return finalizeMetrics(metrics);
}

function lineEvidence(
  line: MutableLine,
  moduleChunks?: ReadonlySet<string>,
): Pick<LineAssetEvidence, "emittedBytes" | "loadedBytes" | "executedBytes"> {
  if (!moduleChunks?.size) return line;
  const result = { emittedBytes: 0, loadedBytes: 0, executedBytes: 0 };
  for (const evidence of line.assets.values()) {
    if (!evidence.chunks.some((chunk) => moduleChunks.has(chunk))) continue;
    result.emittedBytes += evidence.emittedBytes;
    result.loadedBytes += evidence.loadedBytes;
    result.executedBytes += evidence.executedBytes;
  }
  return result;
}

async function toFileReports(
  files: Map<string, MutableFile>,
  build: BuildManifest,
  loadSourceContent: (path: string) => Promise<string | null>,
  onProgress?: (phase: string, completed: number, total: number) => void,
  onFileDetail?: (file: StoredSourceFileDetail) => void | Promise<void>,
): Promise<SourceFileSummary[]> {
  const sourceFiles = [...files.values()];
  const reports: SourceFileSummary[] = [];
  const moduleIndex = buildSourceModuleIndex(build, onProgress);
  let lastProgressAt = Date.now();
  onProgress?.("Building file reports", 0, sourceFiles.length);

  for (let index = 0; index < sourceFiles.length; index += 1) {
    const file = sourceFiles[index] as MutableFile;
    finalizeMetrics(file.metrics);
    const modules = modulesForSource(moduleIndex, file.path);
    const moduleIds: string[] = [];
    const chunks = new Set(file.chunks);
    for (const module of modules) {
      moduleIds.push(module.id);
      for (const chunk of module.chunks) chunks.add(chunk);
    }
    const fileChunks = [...chunks];
    const loadedChunks = [...file.loadedChunks];
    const content = await loadSourceContent(file.path);
    const moduleMetrics =
      modules.length === 1
        ? retainedSourceMetrics(file, content, new Set(modules[0]?.chunks))
        : retainedSourceMetrics(file, content);
    const moduleMetricsById =
      modules.length > 1
        ? Object.fromEntries(
            modules.map((module) => [
              module.id,
              retainedSourceMetrics(file, content, new Set(module.chunks)) ?? emptyMetrics(),
            ]),
          )
        : undefined;
    const summary: SourceFileSummary = {
      id: file.path,
      path: file.path,
      displayPath: file.path,
      category: sourceCategory(file.path),
      metrics: file.metrics,
      moduleMetrics: modules.length > 0 ? moduleMetrics : null,
      ...(moduleMetricsById ? { moduleMetricsById } : {}),
      chunks: fileChunks,
      loadedChunks,
      moduleIds,
      duplicated: new Set(loadedChunks).size > 1,
    };
    await onFileDetail?.({
      id: file.path,
      content,
      sourceMapAvailable: build.capabilities.sourceMap !== "none",
      chunks: fileChunks,
      mappedLines: [...file.lines].map(([lineIndex, line]) => ({
        lineIndex,
        emittedBytes: line.emittedBytes,
        loadedBytes: line.loadedBytes,
        executedBytes: line.executedBytes,
        chunks: [...line.chunks],
        ranges: line.ranges,
        ...(modules.length > 1
          ? {
              moduleStates: Object.fromEntries(
                modules.map((module) => [module.id, lineEvidence(line, new Set(module.chunks))]),
              ),
            }
          : {}),
      })),
    });
    reports.push(summary);

    const now = Date.now();
    if (index === sourceFiles.length - 1 || now - lastProgressAt >= 100) {
      onProgress?.("Building file reports", index + 1, sourceFiles.length);
      lastProgressAt = now;
    }
  }

  return reports.sort(
    (a, b) => b.metrics.unusedBytes - a.metrics.unusedBytes || a.path.localeCompare(b.path),
  );
}

function buildTree(files: SourceFileSummary[]): TreeNodeReport {
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
  const directories = new Map<string, TreeNodeReport>();

  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let parent = root;
    let currentPath = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index] ?? "[unknown]";
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      let child = directories.get(currentPath);
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
        directories.set(currentPath, child);
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

function buildOpportunities(files: SourceFileSummary[], chunks: ChunkReport[]): Opportunity[] {
  const opportunities: Opportunity[] = [];
  for (const file of files) {
    const metrics = file.moduleMetrics;
    if (!metrics || metrics.loadedBytes === 0) continue;
    if (metrics.unusedBytes >= 1024) {
      opportunities.push({
        id: `unused:${file.id}`,
        kind: "largest-unused",
        title: "Large unused retained module",
        description:
          "Rspack retained these original-source lines in a loaded module, but much of that source did not execute in this recording.",
        path: file.path,
        fileId: file.id,
        metrics,
        evidence: [
          `${metrics.unusedBytes} unused retained source bytes`,
          `${file.loadedChunks.length} loaded chunk(s)`,
        ],
      });
    }
    if ((metrics.usageRatio ?? 1) < 0.25 && metrics.loadedBytes >= 10_000) {
      opportunities.push({
        id: `low:${file.id}`,
        kind: "low-usage",
        title: "Low runtime usage",
        description:
          "A large emitted contribution has low execution coverage in the imported user journey.",
        path: file.path,
        fileId: file.id,
        metrics,
        evidence: [`${Math.round((metrics.usageRatio ?? 0) * 100)}% byte usage`],
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
        metrics,
        evidence: file.loadedChunks.map((chunk) => `Loaded chunk ${chunk}`),
      });
    }
    if (
      /(?:locale|locales|schema|schemas|polyfill|icons?)(?:\/|\.|-)/i.test(file.path) &&
      metrics.loadedBytes >= 4096
    ) {
      opportunities.push({
        id: `collection:${file.id}`,
        kind: "collection",
        title: "Large collection-like source",
        description:
          "The path looks like a locale, schema, polyfill, or icon collection. Check whether narrower imports or lazy loading fit the product behavior.",
        path: file.path,
        fileId: file.id,
        metrics,
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

export async function analyzeCoverage(input: {
  build: BuildManifest;
  coverage: ChromeCoverageEntry[];
  maps?: Record<string, RawSourceMapPayload>;
  generatedAssets?: Record<string, string>;
  /** In-memory compatibility input. Persistent analysis should use the lazy provider below. */
  originalSources?: Record<string, string>;
  originalSourcePaths?: Iterable<string>;
  loadOriginalSource?: (sourceKey: string) => Promise<string | null>;
  storeDiscoveredSource?: (sourceKey: string, content: string) => Promise<void>;
  precision: CoverageImportSummary["precision"];
  onProgress?: (phase: string, completed: number, total: number) => void;
  onFileDetail?: (file: StoredSourceFileDetail) => void | Promise<void>;
  loadAsset?: (
    assetId: string,
    needsGeneratedSource: boolean,
  ) => Promise<{ generated?: string; map?: RawSourceMapPayload }>;
}): Promise<CoverageReport> {
  if (!Array.isArray(input.coverage)) throw new Error("Chrome Coverage JSON must be an array.");
  const { matched, ignored } = await matchCoverage(input.build, input.coverage);
  if (matched.size === 0) {
    throw new Error("No JavaScript assets in this Coverage file match the current build.");
  }

  const files = new Map<string, MutableFile>();
  const capturedContentIndex: CapturedSourceContentIndex = {
    exact: new Map(),
    suffix: new Map(),
  };
  const inlineSources = input.originalSources ?? {};
  const discoveredSources = new Map<string, string>();
  const registerSource = (source: string, sourceKey: string) => {
    const path = normalizeSourcePathForContext(source, input.build.context);
    mutableFile(files, path);
    indexCapturedSourceContent(capturedContentIndex, path, sourceKey);
  };
  for (const source of Object.keys(inlineSources)) registerSource(source, source);
  for (const source of input.originalSourcePaths ?? []) {
    const path = normalizeSourcePathForContext(source, input.build.context);
    if (!capturedContentIndex.exact.has(path)) registerSource(source, source);
  }
  const loadSourceContent = async (path: string): Promise<string | null> => {
    const sourceKey = capturedSourceKey(capturedContentIndex, path);
    if (sourceKey === null) return null;
    if (Object.hasOwn(inlineSources, sourceKey)) return inlineSources[sourceKey] ?? null;
    const discovered = discoveredSources.get(sourceKey);
    if (discovered !== undefined || discoveredSources.has(sourceKey)) return discovered ?? null;
    return (await input.loadOriginalSource?.(sourceKey)) ?? null;
  };
  const rememberDiscoveredSource = async (path: string, content: string): Promise<void> => {
    if (capturedSourceKey(capturedContentIndex, path) !== null) return;
    if (input.storeDiscoveredSource) await input.storeDiscoveredSource(path, content);
    else discoveredSources.set(path, content);
    indexCapturedSourceContent(capturedContentIndex, path, path);
  };
  const globalMetrics = emptyMetrics();
  const assetMetrics = new Map<string, UsageMetrics>();
  const loadedChunkIds = new Set<string>();

  for (let index = 0; index < input.build.assets.length; index += 1) {
    const asset = input.build.assets[index] as BuildAsset;
    input.onProgress?.("Mapping generated code", index, input.build.assets.length);
    const coverage = matched.get(asset.id);
    const loaded = Boolean(coverage);
    const loadedAsset = input.loadAsset ? await input.loadAsset(asset.id, !coverage) : undefined;
    const generated = coverage?.text ?? loadedAsset?.generated ?? input.generatedAssets?.[asset.id];
    const ranges = coverage?.ranges ?? [];
    const map = loadedAsset?.map ?? input.maps?.[asset.id];
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
        ? normalizeSourcePathForContext(span.source, input.build.context)
        : `[rspack runtime / unmapped]/${asset.name}`;
      if (span.sourceContent !== null) {
        await rememberDiscoveredSource(path, span.sourceContent);
      }
      const file = mutableFile(files, path);
      addMetrics(file.metrics, metrics);
      for (const chunk of asset.chunks) {
        file.chunks.add(chunk);
        if (loaded) file.loadedChunks.add(chunk);
      }
      if (span.originalLine !== null) {
        const startColumn = Math.max(0, span.originalColumn ?? 0);
        const endColumn = Math.max(startColumn + 1, span.originalEndColumn ?? startColumn + 1);
        addLineBytes(file, span.originalLine, {
          emitted: emittedBytes,
          loaded: loaded ? emittedBytes : 0,
          executed: executedBytes,
          chunks: asset.chunks,
          assetId: asset.id,
          startColumn,
          endColumn,
        });
      }
    }
    assetMetrics.set(asset.id, finalizeMetrics(currentAssetMetrics));
    addMetrics(globalMetrics, currentAssetMetrics);
  }
  input.onProgress?.(
    "Mapping generated code",
    input.build.assets.length,
    input.build.assets.length,
  );

  const fileReports = await toFileReports(
    files,
    input.build,
    loadSourceContent,
    input.onProgress,
    input.onFileDetail,
  );
  const moduleMetrics = emptyMetrics();
  for (const file of fileReports) {
    if (file.moduleMetrics) addMetrics(moduleMetrics, file.moduleMetrics);
  }
  input.onProgress?.("Aggregating report", 0, 1);
  const tree = buildTree(fileReports);
  const assetsByName = new Map<string, BuildAsset>();
  for (const asset of input.build.assets) {
    if (!assetsByName.has(asset.name)) assetsByName.set(asset.name, asset);
  }
  const duplicatedSourcesByChunk = new Map<string, number>();
  for (const file of fileReports) {
    if (!file.duplicated) continue;
    for (const chunk of file.chunks) {
      duplicatedSourcesByChunk.set(chunk, (duplicatedSourcesByChunk.get(chunk) ?? 0) + 1);
    }
  }
  const chunks: ChunkReport[] = input.build.chunks.map((chunk) => {
    const metrics = emptyMetrics();
    for (const file of chunk.files) {
      const asset = assetsByName.get(file);
      if (asset) addMetrics(metrics, assetMetrics.get(asset.id) ?? emptyMetrics());
    }
    return {
      ...chunk,
      loaded: loadedChunkIds.has(chunk.id),
      metrics: finalizeMetrics(metrics),
      duplicatedSources: duplicatedSourcesByChunk.get(chunk.id) ?? 0,
    };
  });

  const report: CoverageReport = {
    version: 2,
    buildHash: input.build.hash,
    createdAt: Date.now(),
    metrics: finalizeMetrics(globalMetrics),
    moduleMetrics: finalizeMetrics(moduleMetrics),
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
  input.onProgress?.("Aggregating report", 1, 1);
  return report;
}

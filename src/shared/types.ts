export type BuildState = "retained" | "not-emitted" | "unknown";

export type RuntimeState = "not-loaded" | "not-executed" | "executed";

export interface UsageMetrics {
  emittedBytes: number;
  loadedBytes: number;
  executedBytes: number;
  unusedBytes: number;
  notLoadedBytes: number;
  mappedBytes: number;
  unmappedBytes: number;
  usageRatio: number | null;
}

export interface ChromeCoverageRange {
  start: number;
  end: number;
}

export interface ChromeCoverageEntry {
  url: string;
  text: string;
  ranges: ChromeCoverageRange[];
}

export interface BuildAsset {
  id: string;
  name: string;
  urlPath: string;
  size: number;
  contentHash: string;
  chunks: string[];
  mapAvailable: boolean;
}

export interface BuildChunk {
  id: string;
  names: string[];
  files: string[];
  initial: boolean;
  entry: boolean;
  moduleIds: string[];
  emittedBytes: number;
}

export interface BuildModule {
  id: string;
  runtimeId?: string | null;
  identifier: string;
  readableIdentifier?: string;
  name: string;
  resource: string | null;
  /** Original source-map sources owned by this Rspack module after loaders. */
  sourcePaths?: string[];
  moduleType: string;
  chunks: string[];
  issuer: string | null;
  type?: string | null;
  layer?: string | null;
  entry?: boolean;
  showFullIdentifier?: boolean;
  size: number;
  usedExports: boolean | string[] | null;
  providedExports: string[] | null;
  optimizationBailout: string[];
  nested: boolean;
}

export interface AnalysisCapabilities {
  usedExports: "enabled" | "disabled" | "unknown";
  sourceMap: "full" | "line-only" | "none";
  originalLocations: "exact" | "line-only" | "unavailable";
}

export interface ReferenceLocation {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

export interface BuildReference {
  id: string;
  originId: string;
  targetId: string;
  dependencyType: string | null;
  request: string | null;
  exports: string[] | null;
  active: boolean | null;
  /** Location in the post-loader module source used by Rspack's parser. */
  location: ReferenceLocation | null;
  /** Original source and location after tracing the module's loader source map. */
  sourcePath?: string | null;
  sourceLocation?: ReferenceLocation | null;
}

export interface ModuleCodeGeneration {
  moduleId: string;
  runtimes: string[][];
  content: string;
  map: RawSourceMapPayload | null;
  mapError: string | null;
}

export interface BuildEntrypoint {
  name: string;
  chunks: string[];
  assets: string[];
}

export interface BuildDiagnostic {
  severity: "error" | "warning";
  message: string;
  moduleName?: string;
  file?: string;
}

export interface BuildManifest {
  hash: string;
  mode: string;
  context: string;
  publicPath: string;
  builtAt: number;
  assets: BuildAsset[];
  chunks: BuildChunk[];
  modules: BuildModule[];
  entrypoints: BuildEntrypoint[];
  diagnostics: BuildDiagnostic[];
  capabilities: AnalysisCapabilities;
  counts: {
    assets: number;
    javascriptAssets: number;
    chunks: number;
    modules: number;
    sourceMaps: number;
    references?: number;
    codeGenerationSources?: number;
  };
  previewAvailable: boolean;
  publicPathSupported: boolean;
}

export interface RawSourceMapPayload {
  version: number;
  file?: string;
  sourceRoot?: string;
  sources: string[];
  sourcesContent?: Array<string | null>;
  names: string[];
  mappings: string;
  [key: string]: unknown;
}

export interface BuildSnapshot {
  manifest: BuildManifest;
  assets: ReadonlyMap<string, Buffer>;
  maps: ReadonlyMap<string, RawSourceMapPayload>;
  /** Raw JSON source-map payloads used to persist/copy maps without re-stringifying them. */
  mapPayloads?: ReadonlyMap<string, Buffer>;
  originalSources: ReadonlyMap<string, string>;
  exportGraph: ExportGraphSnapshot;
  references: BuildReference[];
  /** Disk-backed reference access used by persisted or spill-to-disk snapshots. */
  referenceStore?: BuildReferenceStore;
  /** Disk-backed export graph access used by persisted snapshots. */
  exportGraphStore?: ExportGraphStore;
  codeGeneration: ReadonlyMap<string, ModuleCodeGeneration[]>;
  loadCodeGeneration?: (moduleId: string) => ModuleCodeGeneration[];
  /** Release a lazily materialized code-generation record after it has been persisted. */
  releaseCodeGeneration?: (moduleId: string) => void;
  /** Release temporary spill files or database handles owned by this snapshot. */
  dispose?: () => void;
  outputPath: string;
  indexAsset: string | null;
  storage?: {
    version: 2;
    snapshotId: string;
    directory: string;
  };
}

export type ReferenceDirection = "in" | "out" | "both";

export interface BuildReferenceStore {
  readonly size: number;
  get(id: string): BuildReference | undefined;
  count(moduleId: string, direction: ReferenceDirection): number;
  page(
    moduleId: string,
    direction: ReferenceDirection,
    cursor: number,
    limit: number,
  ): BuildReference[];
  incomingOrigins(moduleId: string): string[];
  countTargets(targetModuleIds: ReadonlySet<string>): number;
  forTargets(targetModuleIds: ReadonlySet<string>): BuildReference[];
  entries(): IterableIterator<BuildReference>;
}

export interface ExportGraphStore {
  getModule(moduleId: string): ExportGraphModule | undefined;
  moduleIdsForSource(source: string): string[];
  edgesForTargets(targetModuleIds: ReadonlySet<string>): ExportReferenceEdge[];
}

export type CodeCoverageState =
  | "executed"
  | "unexecuted"
  | "not-emitted"
  | "unloaded"
  | "unknown"
  | "neutral";

export interface CodeCoverageSpan {
  start: number;
  end: number;
  status: CodeCoverageState;
  count?: number | null;
}

export interface CodeViewResponse {
  view: "source" | "output";
  sourceId: string | null;
  filename: string;
  language: string;
  content: string;
  spans: CodeCoverageSpan[];
  offset: number;
  endOffset: number;
  startLine: number;
  totalCharacters: number;
  hasPrevious: boolean;
  hasNext: boolean;
  provenance: string;
  gap: string | null;
}

export interface ModuleViewAvailability {
  source: boolean;
  output: boolean;
  finalAsset: boolean;
  codeGeneration: boolean;
  hasMappedOutput: boolean;
  preferred: "source" | "output";
  outputKind: "final-asset" | "module-code-generation" | null;
}

export interface ModuleInvestigationDetail extends BuildModule {
  sources: Array<{
    id: string;
    name: string;
    mappedBytes: number;
    loadedBytes: number;
    executedBytes: number;
  }>;
  metrics: UsageMetrics;
  incomingReferences: number;
  outgoingReferences: number;
  views: ModuleViewAvailability;
}

export interface ReferenceEdgeReport extends BuildReference {
  origin: BuildModule;
  target: BuildModule;
}

export interface ModuleReferencesResponse {
  module: BuildModule;
  direction: "in" | "out" | "both";
  counts: {
    in: number;
    out: number;
    both: number;
  };
  total: number;
  cursor: number;
  nextCursor: number | null;
  edges: ReferenceEdgeReport[];
  entryPath: BuildModule[];
}

export interface ReferenceSnippetResponse {
  edge: BuildReference;
  available: boolean;
  gap: string | null;
  /** Full source code with the same Coverage evidence used by the source detail panel. */
  code?: CodeViewResponse;
  filename?: string;
  startLine?: number;
  endLine?: number;
  content?: string;
  highlight?: {
    start: number;
    end: number;
    coverageStatus: CodeCoverageState;
  };
  coverage?: UsageMetrics;
  location?: ReferenceLocation;
}

export interface SourcePosition {
  line: number;
  column: number;
}

export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
}

export interface ExportGraphModule {
  id: string;
  identifier: string;
  resource: string | null;
  moduleType: string;
  chunks: string[];
  providedExports: string[] | null;
  usedExports: boolean | string[] | null;
  optimizationBailout: string[];
  originalSources: string[];
  transformedSource: string | null;
  sourceMap: RawSourceMapPayload | null;
}

export interface ExportReferenceEdge {
  originModuleId: string;
  targetModuleId: string;
  resolvedModuleId: string | null;
  dependencyType: string;
  request: string | null;
  referencedPath: string[] | null;
  location: SourceRange | null;
  active: boolean;
  /** Original consumer source after tracing loader source maps, when available. */
  sourcePath?: string | null;
  /** Whether `location` is already expressed in `sourcePath` coordinates. */
  originalLocation?: boolean;
}

export interface ExportGraphSnapshot {
  modules: ExportGraphModule[];
  edges: ExportReferenceEdge[];
  sourceToModuleIds: Record<string, string[]>;
}

export type ExportUsageState = "used" | "unused" | "unknown" | "type-only";

export type ExportUsagePrecision = "exact" | "conservative" | "unavailable";

export interface ExportModuleInstance {
  moduleId: string;
  identifier: string;
  resource: string | null;
  chunks: string[];
  state: ExportUsageState;
  precision: ExportUsagePrecision;
  optimizationBailout: string[];
}

export interface ExportReference {
  /** Module that imports and consumes the current export. */
  moduleId: string;
  /** Captured module instance whose export is being consumed. */
  targetModuleId: string;
  path: string;
  line: number | null;
  column: number | null;
  snippet: string | null;
  dependencyType: string;
  request: string | null;
  referencedPath: string[] | null;
  locationPrecision: "exact" | "line-only" | "unavailable";
}

export interface SourceExportUsage {
  id: string;
  exportedName: string;
  localName: string | null;
  range: SourceRange;
  state: ExportUsageState;
  precision: ExportUsagePrecision;
  moduleInstances: ExportModuleInstance[];
  referenceCount: number;
  referenceCountByModule: Record<string, number>;
  references: ExportReference[];
  truncated: boolean;
}

export interface SourceExportUsageReport {
  buildHash: string;
  source: string;
  exports: SourceExportUsage[];
  diagnostics: string[];
  directReferencesOnly: true;
  summary: {
    total: number;
    used: number;
    unused: number;
    unknown: number;
    typeOnly: number;
  };
}

export type SourceExportAnalysisStatus =
  | {
      status: "pending";
      phase: string;
      completed: number;
      total: number;
    }
  | { status: "complete"; report: SourceExportUsageReport }
  | { status: "error"; message: string };

export interface ExportAnalysisInput {
  buildHash: string;
  context: string;
  source: string;
  content: string;
  modules: ExportGraphModule[];
  references: Array<{
    edge: ExportReferenceEdge;
    origin: ExportGraphModule | null;
  }>;
  usedExportsEnabled: boolean;
  originalLocations: AnalysisCapabilities["originalLocations"];
}

export interface SourceLineState {
  line: number;
  text: string;
  buildState: BuildState;
  runtimeState: RuntimeState;
  emittedBytes: number;
  loadedBytes: number;
  executedBytes: number;
  chunks: string[];
  ranges: Array<{
    startColumn: number;
    endColumn: number;
    executed: boolean;
  }>;
}

export interface SourceFileSummary {
  id: string;
  path: string;
  displayPath: string;
  category: "first-party" | "node_modules" | "runtime";
  /** Final generated bytes attributed to this source-map path. */
  metrics: UsageMetrics;
  /**
   * UTF-8 bytes from retained original-source lines, counted once per source.
   * Null means the path is not associated with a Rspack module or its source
   * content is unavailable.
   */
  moduleMetrics?: UsageMetrics | null;
  /** Per-instance metrics, emitted only when one source belongs to multiple modules. */
  moduleMetricsById?: Record<string, UsageMetrics>;
  chunks: string[];
  loadedChunks: string[];
  moduleIds: string[];
  duplicated: boolean;
}

export interface SourceFileReport extends SourceFileSummary {
  content: string | null;
  lines: SourceLineState[];
}

export interface SourceFileDetail {
  id: string;
  lines: SourceLineState[];
}

export interface TreeNodeReport {
  id: string;
  name: string;
  path: string;
  kind: "root" | "directory" | "file";
  category: "all" | "first-party" | "node_modules" | "runtime" | "mixed";
  metrics: UsageMetrics;
  chunks: string[];
  duplicated: boolean;
  fileId?: string;
  children: TreeNodeReport[];
}

export interface ChunkReport extends BuildChunk {
  loaded: boolean;
  metrics: UsageMetrics;
  duplicatedSources: number;
}

export interface Opportunity {
  id: string;
  kind: "largest-unused" | "low-usage" | "duplicated" | "initial-unused" | "collection";
  title: string;
  description: string;
  path: string;
  fileId?: string;
  chunkId?: string;
  metrics: UsageMetrics;
  evidence: string[];
}

export interface CoverageImportSummary {
  importedEntries: number;
  matchedAssets: number;
  ignoredEntries: Array<{ url: string; reason: string }>;
  precision: "per-block" | "per-function" | "unknown";
}

export interface CoverageReport {
  version: 2;
  buildHash: string;
  createdAt: number;
  /** Final-asset metrics, including Rspack runtime and unmapped generated code. */
  metrics: UsageMetrics;
  /** Retained original-source bytes attributable to Rspack modules only. */
  moduleMetrics: UsageMetrics;
  importSummary: CoverageImportSummary;
  tree: TreeNodeReport;
  files: SourceFileSummary[];
  chunks: ChunkReport[];
  opportunities: Opportunity[];
}

export type CoverageAnalysisStatus =
  | { status: "idle"; recentAvailable: boolean }
  | {
      status: "pending";
      id: string;
      phase: string;
      completed: number;
      total: number;
      recentAvailable: boolean;
    }
  | {
      status: "complete";
      id: string;
      report: CoverageReport;
      recentAvailable: boolean;
    }
  | {
      status: "error";
      id: string;
      message: string;
      recentAvailable: boolean;
    };

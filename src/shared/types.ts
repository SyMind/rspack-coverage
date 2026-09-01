export type BuildState = "retained" | "not-emitted" | "unknown";

export type RuntimeState = "not-loaded" | "not-executed" | "partial" | "executed";

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
  chunks: string[];
  issuer: string | null;
  type?: string | null;
  layer?: string | null;
  entry?: boolean;
  showFullIdentifier?: boolean;
  size: number;
  usedExports: boolean | string[] | null;
  providedExports: string[] | null;
  nested: boolean;
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
  originalSources: Map<string, string>;
  references: BuildReference[];
  codeGeneration: Map<string, ModuleCodeGeneration[]>;
  loadCodeGeneration?: (moduleId: string) => ModuleCodeGeneration[];
  outputPath: string;
  indexAsset: string | null;
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

export interface SourceLineState {
  line: number;
  text: string;
  buildState: BuildState;
  runtimeState: RuntimeState;
  emittedBytes: number;
  executedBytes: number;
  chunks: string[];
  ranges: Array<{
    startColumn: number;
    endColumn: number;
    executed: boolean;
  }>;
}

export interface SourceFileReport {
  id: string;
  path: string;
  displayPath: string;
  category: "first-party" | "node_modules" | "runtime";
  metrics: UsageMetrics;
  chunks: string[];
  loadedChunks: string[];
  moduleIds: string[];
  duplicated: boolean;
  content: string | null;
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
  version: 1;
  buildHash: string;
  createdAt: number;
  metrics: UsageMetrics;
  importSummary: CoverageImportSummary;
  tree: TreeNodeReport;
  files: SourceFileReport[];
  chunks: ChunkReport[];
  opportunities: Opportunity[];
}

export type WorkerRequest = {
  type: "analyze";
  build: BuildManifest;
  coverage: ChromeCoverageEntry[];
  maps: Record<string, RawSourceMapPayload>;
  generatedAssets: Record<string, string>;
  originalSources: Record<string, string>;
  precision: CoverageImportSummary["precision"];
};

export type WorkerResponse =
  | { type: "progress"; phase: string; completed: number; total: number }
  | { type: "complete"; report: CoverageReport }
  | { type: "error"; message: string };

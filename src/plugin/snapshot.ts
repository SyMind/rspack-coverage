import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Compiler, Stats } from "@rspack/core";
import { assetUrlPath } from "../shared/path.js";
import type {
  BuildAsset,
  BuildChunk,
  BuildDiagnostic,
  BuildEntrypoint,
  BuildManifest,
  BuildModule,
  BuildReference,
  BuildSnapshot,
  ModuleCodeGeneration,
  RawSourceMapPayload,
  ReferenceLocation,
} from "../shared/types.js";

const JAVASCRIPT_ASSET_RE = /\.(?:js|mjs|cjs)$/i;
const NON_JAVASCRIPT_SOURCE_RE =
  /\.(?:css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|woff2?|ttf|eot)(?:$|[?#])/i;

function isAnalyzableSource(value: string): boolean {
  return !NON_JAVASCRIPT_SOURCE_RE.test(value);
}

function asBuffer(source: unknown): Buffer {
  if (Buffer.isBuffer(source)) return source;
  if (source instanceof Uint8Array) return Buffer.from(source);
  return Buffer.from(String(source));
}

function shortHash(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function asArray<T>(value: Iterable<T> | null | undefined): T[] {
  return value ? [...value] : [];
}

function safeCall<T>(callback: () => T, fallback: T): T {
  try {
    return callback();
  } catch {
    return fallback;
  }
}

class LazySnapshotMap<T> implements ReadonlyMap<string, T> {
  readonly #loaders = new Map<string, () => T | null | undefined>();
  readonly #cache = new Map<string, T>();
  readonly #loaded = new Set<string>();

  get size(): number {
    return this.#loaders.size;
  }

  register(key: string, loader: () => T | null | undefined): void {
    this.#loaders.set(key, loader);
    this.#cache.delete(key);
    this.#loaded.delete(key);
  }

  get(key: string): T | undefined {
    if (this.#loaded.has(key)) return this.#cache.get(key);
    const loader = this.#loaders.get(key);
    if (!loader) return undefined;
    const value = loader() ?? undefined;
    this.#loaded.add(key);
    if (value !== undefined) this.#cache.set(key, value);
    return value;
  }

  has(key: string): boolean {
    return this.#loaders.has(key);
  }

  *entries(): MapIterator<[string, T]> {
    for (const key of this.#loaders.keys()) {
      const value = this.get(key);
      if (value !== undefined) yield [key, value];
    }
  }

  keys(): MapIterator<string> {
    return this.#loaders.keys();
  }

  *values(): MapIterator<T> {
    for (const [, value] of this.entries()) yield value;
  }

  forEach(callbackfn: (value: T, key: string, map: ReadonlyMap<string, T>) => void): void {
    for (const [key, value] of this.entries()) callbackfn(value, key, this);
  }

  [Symbol.iterator](): MapIterator<[string, T]> {
    return this.entries();
  }
}

function moduleIdentifier(module: any): string {
  return String(
    safeCall(() => module.identifier(), null) ??
      safeCall(() => module.readableIdentifier(), null) ??
      module.nameForCondition?.() ??
      "[unknown module]",
  );
}

function stableModuleId(identifier: string, layer: unknown, type: unknown, duplicate = 0): string {
  return `mod_${shortHash(`${identifier}\0${String(layer ?? "")}\0${String(type ?? "")}\0${duplicate}`)}`;
}

function parseSourceMap(value: unknown): RawSourceMapPayload | null {
  if (!value) return null;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "version" in parsed &&
      "sources" in parsed &&
      "mappings" in parsed
    ) {
      return parsed as RawSourceMapPayload;
    }
  } catch {
    return null;
  }
  return null;
}

function getSourceAndMap(asset: any): { content: Buffer; map: RawSourceMapPayload | null } {
  try {
    if (typeof asset.source.sourceAndMap === "function") {
      const result = asset.source.sourceAndMap({ columns: true });
      return {
        content: asBuffer(result.source),
        map: parseSourceMap(result.map),
      };
    }
  } catch {
    // Some third-party Source implementations only support source().
  }

  const content = asBuffer(asset.source.source());
  try {
    const map = typeof asset.source.map === "function" ? asset.source.map({ columns: true }) : null;
    return { content, map: parseSourceMap(map) };
  } catch {
    return { content, map: null };
  }
}

function safeOutputAssetPath(outputPath: string, name: string): string | null {
  const filename = resolve(outputPath, name);
  const relativeName = relative(outputPath, filename);
  if (
    !relativeName ||
    relativeName === ".." ||
    relativeName.startsWith(`..${sep}`) ||
    isAbsolute(relativeName)
  ) {
    return null;
  }
  return filename;
}

function readAssetContent(asset: any, outputPath: string): Buffer | null {
  if (asset?.source) {
    const content = safeCall(() => asBuffer(asset.source.source()), null);
    if (content) return content;
  }
  const filename = safeOutputAssetPath(outputPath, String(asset?.name ?? ""));
  if (!filename) return null;
  return safeCall(() => readFileSync(filename), null);
}

function collectOriginalSources(compilation: Stats["compilation"]): Map<string, string> {
  const sources = new Map<string, string>();
  for (const module of compilation.modules) {
    try {
      const originalSource = module.originalSource();
      if (!originalSource) continue;
      const sourceAndMap = getSourceAndMap({ source: originalSource });
      if (sourceAndMap.map?.sourcesContent) {
        for (let index = 0; index < sourceAndMap.map.sources.length; index += 1) {
          const content = sourceAndMap.map.sourcesContent[index];
          const name = sourceAndMap.map.sources[index];
          const rootedName =
            name && sourceAndMap.map.sourceRoot
              ? `${sourceAndMap.map.sourceRoot.replace(/\/$/, "")}/${name.replace(/^\//, "")}`
              : name;
          if (typeof content === "string" && rootedName && isAnalyzableSource(rootedName)) {
            sources.set(rootedName, content);
          }
        }
      }
      const resource = module.nameForCondition();
      if (resource && isAnalyzableSource(resource) && !sources.has(resource)) {
        sources.set(resource, sourceAndMap.content.toString("utf8"));
      }
    } catch {
      // Synthetic and runtime modules may not expose an original source.
    }
  }
  return sources;
}

function stringifyDiagnostic(diagnostic: any): string {
  if (typeof diagnostic === "string") return diagnostic;
  if (typeof diagnostic?.message === "string") return diagnostic.message;
  if (typeof diagnostic?.details === "string") return diagnostic.details;
  try {
    return JSON.stringify(diagnostic);
  } catch {
    return String(diagnostic);
  }
}

function collectDiagnostics(json: any): BuildDiagnostic[] {
  const diagnostics: BuildDiagnostic[] = [];
  for (const [severity, values] of [
    ["error", json.errors ?? []],
    ["warning", json.warnings ?? []],
  ] as const) {
    for (const value of values) {
      diagnostics.push({
        severity,
        message: stringifyDiagnostic(value),
        ...(value?.moduleName ? { moduleName: String(value.moduleName) } : {}),
        ...(value?.file ? { file: String(value.file) } : {}),
      });
    }
  }
  return diagnostics;
}

function collectModules(rawModules: any[], entryIdentifiers: Set<string>): BuildModule[] {
  const modules: BuildModule[] = [];
  const seen = new Map<string, number>();

  const visit = (raw: any, inheritedChunks: string[], nested: boolean): void => {
    const identifier = String(raw.identifier ?? raw.name ?? "[unknown module]");
    const identity = `${identifier}\0${String(raw.layer ?? "")}\0${String(raw.moduleType ?? raw.type ?? "")}`;
    const duplicateIndex = seen.get(identity) ?? 0;
    seen.set(identity, duplicateIndex + 1);
    const id = stableModuleId(identifier, raw.layer, raw.moduleType ?? raw.type, duplicateIndex);
    const chunks = (raw.chunks?.length ? raw.chunks : inheritedChunks).map(String);
    const resource = raw.nameForCondition ? String(raw.nameForCondition) : null;
    const readableIdentifier = String(raw.name ?? resource ?? identifier);

    modules.push({
      id,
      runtimeId: raw.id === null || raw.id === undefined ? null : String(raw.id),
      identifier,
      readableIdentifier,
      name: readableIdentifier,
      resource,
      chunks,
      issuer: raw.issuerName ? String(raw.issuerName) : null,
      type: raw.moduleType ? String(raw.moduleType) : null,
      layer: raw.layer ? String(raw.layer) : null,
      entry: entryIdentifiers.has(identifier),
      size: Number(raw.size ?? 0),
      usedExports:
        typeof raw.usedExports === "boolean" || raw.usedExports === null
          ? raw.usedExports
          : Array.isArray(raw.usedExports)
            ? raw.usedExports.map(String)
            : null,
      providedExports: Array.isArray(raw.providedExports) ? raw.providedExports.map(String) : null,
      nested,
    });

    for (const child of raw.modules ?? []) visit(child, chunks, true);
  };

  for (const raw of rawModules) visit(raw, [], false);
  const readableCounts = new Map<string, number>();
  for (const module of modules) {
    const readable = module.readableIdentifier ?? module.name;
    readableCounts.set(readable, (readableCounts.get(readable) ?? 0) + 1);
  }
  for (const module of modules) {
    module.showFullIdentifier =
      (readableCounts.get(module.readableIdentifier ?? module.name) ?? 0) > 1;
  }
  return modules;
}

function moduleLookup(modules: BuildModule[]): Map<string, BuildModule[]> {
  const lookup = new Map<string, BuildModule[]>();
  for (const module of modules) {
    const values = lookup.get(module.identifier) ?? [];
    values.push(module);
    lookup.set(module.identifier, values);
  }
  return lookup;
}

function buildModuleFor(module: any, lookup: Map<string, BuildModule[]>): BuildModule | null {
  const candidates = lookup.get(moduleIdentifier(module)) ?? [];
  if (candidates.length <= 1) return candidates[0] ?? null;
  const layer = String(module.layer ?? "");
  const type = String(module.type ?? "");
  return (
    candidates.find(
      (candidate) =>
        String(candidate.layer ?? "") === layer && String(candidate.type ?? "") === type,
    ) ??
    candidates[0] ??
    null
  );
}

function normalizeLocation(value: any): ReferenceLocation | null {
  if (!value?.start || !Number.isFinite(Number(value.start.line))) return null;
  // Rspack dependency locations expose one-based columns, while JavaScript string
  // offsets (and source-map columns) are zero-based. Normalize once at capture time
  // so every server/UI consumer can slice source text directly.
  const rawStartColumn = Number(value.start.column ?? 1);
  const start = {
    line: Math.max(1, Number(value.start.line)),
    column: Math.max(0, rawStartColumn - 1),
  };
  const endValue = value.end?.line ? value.end : value.start;
  const rawEndColumn = Number(endValue.column ?? rawStartColumn + 1);
  return {
    start,
    end: {
      line: Math.max(start.line, Number(endValue.line ?? start.line)),
      column: Math.max(start.column + 1, rawEndColumn - 1),
    },
  };
}

function collectReferences(
  compilation: Stats["compilation"],
  lookup: Map<string, BuildModule[]>,
): BuildReference[] {
  const references: BuildReference[] = [];
  const seen = new Map<string, number>();
  for (const originModule of compilation.modules as Iterable<any>) {
    const origin = buildModuleFor(originModule, lookup);
    if (!origin) continue;
    const connections = safeCall(
      () => asArray((compilation.moduleGraph as any).getOutgoingConnections(originModule)),
      [],
    );
    for (const connection of connections as any[]) {
      const targetModule = connection.resolvedModule ?? connection.module;
      const target = targetModule ? buildModuleFor(targetModule, lookup) : null;
      if (!target) continue;
      const dependency = connection.dependency ?? null;
      const dependencyType = dependency?.type ? String(dependency.type) : null;
      const request = dependency?.request ? String(dependency.request) : null;
      const exports = Array.isArray(dependency?.ids) ? dependency.ids.map(String) : null;
      const location = normalizeLocation(dependency?.loc);
      const identity = `${origin.id}\0${target.id}\0${dependencyType ?? ""}\0${request ?? ""}\0${JSON.stringify(
        location,
      )}\0${JSON.stringify(exports)}`;
      const duplicate = seen.get(identity) ?? 0;
      seen.set(identity, duplicate + 1);
      const activeState = safeCall(() => connection.getActiveState(undefined), null);
      references.push({
        id: `ref_${shortHash(`${identity}\0${duplicate}`)}`,
        originId: origin.id,
        targetId: target.id,
        dependencyType,
        request,
        exports,
        active: typeof activeState === "boolean" ? activeState : null,
        location,
      });
    }
  }
  return references.sort((left, right) =>
    `${left.originId}\0${left.targetId}\0${left.id}`.localeCompare(
      `${right.originId}\0${right.targetId}\0${right.id}`,
    ),
  );
}

function moduleRuntimeSpecs(compilation: Stats["compilation"], module: any): string[][] {
  const chunks = safeCall(
    () => asArray((compilation.chunkGraph as any).getModuleChunksIterable(module)),
    [],
  );
  const unique = new Map<string, string[]>();
  for (const chunk of chunks as any[]) {
    const runtime = chunk.runtime;
    const values = (typeof runtime === "string" ? [runtime] : asArray(runtime as Iterable<unknown>))
      .map(String)
      .sort();
    unique.set(JSON.stringify(values), values);
  }
  return [...unique.values()];
}

function collectCodeGenerationForModule(
  compilation: Stats["compilation"],
  rawModule: any,
  module: BuildModule,
): ModuleCodeGeneration[] {
  const runtimes = moduleRuntimeSpecs(compilation, rawModule);
  const requestedRuntimes = runtimes.length ? runtimes : [[]];
  const byContent = new Map<string, ModuleCodeGeneration>();
  for (const runtime of requestedRuntimes) {
    const runtimeArgument =
      runtime.length === 0 ? undefined : runtime.length === 1 ? runtime[0] : runtime;
    const result = safeCall(
      () => (compilation.codeGenerationResults as any).get(rawModule, runtimeArgument),
      null,
    );
    const sources = result?.sources ?? null;
    const javascriptSource = sources
      ? safeCall(
          () =>
            typeof sources.get === "function"
              ? sources.get("javascript")
              : sources._get("javascript"),
          null,
        )
      : null;
    if (!javascriptSource) continue;
    const captured = safeCall(() => getSourceAndMap({ source: javascriptSource }), null);
    if (!captured) continue;
    const content = captured.content.toString("utf8");
    if (!content) continue;
    const digest = shortHash(`${content}\0${JSON.stringify(captured.map)}`);
    const existing = byContent.get(digest);
    if (existing) {
      existing.runtimes.push(runtime);
    } else {
      byContent.set(digest, {
        moduleId: module.id,
        runtimes: [runtime],
        content,
        map: captured.map,
        mapError: captured.map ? null : "Module code generation did not expose a source map",
      });
    }
  }
  return [...byContent.values()];
}

function createCodeGenerationStore(
  compilation: Stats["compilation"],
  lookup: Map<string, BuildModule[]>,
): {
  cache: Map<string, ModuleCodeGeneration[]>;
  load: (moduleId: string) => ModuleCodeGeneration[];
} {
  const rawModules = new Map<string, { raw: any; module: BuildModule }>();
  for (const raw of compilation.modules as Iterable<any>) {
    const module = buildModuleFor(raw, lookup);
    if (module && !rawModules.has(module.id)) rawModules.set(module.id, { raw, module });
  }
  const cache = new Map<string, ModuleCodeGeneration[]>();
  return {
    cache,
    load(moduleId) {
      const cached = cache.get(moduleId);
      if (cached) return cached;
      const target = rawModules.get(moduleId);
      if (!target) return [];
      const records = collectCodeGenerationForModule(compilation, target.raw, target.module);
      cache.set(moduleId, records);
      return records;
    },
  };
}

function collectEntrypoints(raw: Record<string, any> | undefined): BuildEntrypoint[] {
  if (!raw) return [];
  return Object.entries(raw).map(([name, value]) => ({
    name,
    chunks: (value.chunks ?? []).map(String),
    assets: (value.assets ?? []).map((asset: string | { name: string }) =>
      typeof asset === "string" ? asset : asset.name,
    ),
  }));
}

function getPublicPath(compiler: Compiler, json: any): string {
  const value = json.publicPath ?? compiler.options.output.publicPath ?? "auto";
  return typeof value === "string" ? value : "auto";
}

export function createBuildSnapshot(
  stats: Stats,
  compiler: Compiler,
  privateMaps: Map<string, RawSourceMapPayload | Buffer | string> = new Map(),
): BuildSnapshot {
  const compilation = stats.compilation;
  const json = stats.toJson({
    all: false,
    hash: true,
    publicPath: true,
    assets: true,
    chunks: true,
    chunkGroups: true,
    entrypoints: true,
    modules: true,
    nestedModules: true,
    ids: true,
    usedExports: true,
    providedExports: true,
    errors: true,
    warnings: true,
    errorDetails: true,
  } as any) as any;

  const publicPath = getPublicPath(compiler, json);
  const publicPathSupported = !/^https?:\/\//i.test(publicPath) && !publicPath.startsWith("//");
  const statsAssets = new Map((json.assets ?? []).map((asset: any) => [asset.name, asset]));
  const compilationAssets = compilation.getAssets();
  const emittedMapLoaders = new Map<string, () => RawSourceMapPayload | null>();
  for (const asset of compilationAssets) {
    if (!asset.name.endsWith(".map")) continue;
    emittedMapLoaders.set(asset.name, () => {
      const content = readAssetContent(asset, compiler.outputPath);
      return content ? parseSourceMap(content.toString("utf8")) : null;
    });
  }
  const assets = new LazySnapshotMap<Buffer>();
  const maps = new LazySnapshotMap<RawSourceMapPayload>();
  const manifestAssets: BuildAsset[] = [];

  const unavailableAssets: string[] = [];
  for (const asset of compilationAssets) {
    if (!JAVASCRIPT_ASSET_RE.test(asset.name)) continue;
    const content = readAssetContent(asset, compiler.outputPath);
    if (!content) {
      unavailableAssets.push(asset.name);
      continue;
    }
    const relatedMapName = (asset.info as any).related?.sourceMap;
    const privateMap = privateMaps.get(asset.name);
    const sourceMapLoader = privateMap
      ? () => parseSourceMap(Buffer.isBuffer(privateMap) ? privateMap.toString("utf8") : privateMap)
      : typeof relatedMapName === "string" && emittedMapLoaders.has(relatedMapName)
        ? emittedMapLoaders.get(relatedMapName)
        : emittedMapLoaders.get(`${asset.name}.map`);
    const id = shortHash(`${asset.name}:${shortHash(content)}`);
    const statsAsset = statsAssets.get(asset.name) as any;
    assets.register(id, () => readAssetContent(asset, compiler.outputPath));
    if (sourceMapLoader) maps.register(id, sourceMapLoader);
    manifestAssets.push({
      id,
      name: asset.name,
      urlPath: assetUrlPath(publicPath, asset.name),
      size: content.byteLength,
      contentHash: shortHash(content),
      chunks: (statsAsset?.chunks ?? []).map(String),
      mapAvailable: Boolean(sourceMapLoader),
    });
  }

  const entryIdentifiers = new Set<string>();
  for (const chunk of compilation.chunks as Iterable<any>) {
    for (const module of safeCall(
      () => asArray((compilation.chunkGraph as any).getChunkEntryModulesIterable(chunk)),
      [],
    ) as any[]) {
      entryIdentifiers.add(moduleIdentifier(module));
    }
  }
  const modules = collectModules(json.modules ?? [], entryIdentifiers);
  const modulesByIdentifier = moduleLookup(modules);
  const references = collectReferences(compilation, modulesByIdentifier);
  const codeGenerationStore = createCodeGenerationStore(compilation, modulesByIdentifier);
  const moduleIdsByChunk = new Map<string, string[]>();
  for (const module of modules) {
    for (const chunkId of module.chunks) {
      const list = moduleIdsByChunk.get(chunkId) ?? [];
      list.push(module.id);
      moduleIdsByChunk.set(chunkId, list);
    }
  }
  const assetByName = new Map(manifestAssets.map((asset) => [asset.name, asset]));
  const chunks: BuildChunk[] = (json.chunks ?? []).map((chunk: any) => {
    const id = String(chunk.id ?? chunk.names?.[0] ?? "unknown");
    const files = (chunk.files ?? []).filter((file: string) => JAVASCRIPT_ASSET_RE.test(file));
    return {
      id,
      names: (chunk.names ?? []).map(String),
      files,
      initial: Boolean(chunk.initial),
      entry: Boolean(chunk.entry),
      moduleIds: moduleIdsByChunk.get(id) ?? [],
      emittedBytes: files.reduce(
        (sum: number, file: string) => sum + (assetByName.get(file)?.size ?? 0),
        0,
      ),
    };
  });

  const diagnostics = collectDiagnostics(json);
  if (unavailableAssets.length) {
    diagnostics.push({
      severity: "warning",
      message: `${unavailableAssets.length} JavaScript asset(s) could not be read from the compilation or output directory: ${unavailableAssets.slice(0, 5).join(", ")}${unavailableAssets.length > 5 ? ", …" : ""}.`,
    });
  }
  if (!publicPathSupported) {
    diagnostics.push({
      severity: "warning",
      message:
        "Absolute CDN publicPath is not supported by the local preview. Use publicPath: 'auto', a relative path, or a local path for the analysis build.",
    });
  }

  const htmlAssets = compilation
    .getAssets()
    .filter((asset) => asset.name.endsWith(".html"))
    .sort((a, b) => Number(a.name !== "index.html") - Number(b.name !== "index.html"));
  for (const asset of htmlAssets) {
    const content = readAssetContent(asset, compiler.outputPath);
    if (content)
      assets.register(`html:${asset.name}`, () => readAssetContent(asset, compiler.outputPath));
  }

  const manifest: BuildManifest = {
    hash: String(json.hash ?? compilation.hash ?? "unknown"),
    mode: String(compiler.options.mode ?? "none"),
    context: compiler.context,
    publicPath,
    builtAt: Date.now(),
    assets: manifestAssets,
    chunks,
    modules,
    entrypoints: collectEntrypoints(json.entrypoints),
    diagnostics,
    counts: {
      assets: compilation.getAssets().length,
      javascriptAssets: manifestAssets.length,
      chunks: chunks.length,
      modules: modules.length,
      sourceMaps: maps.size,
      references: references.length,
    },
    previewAvailable:
      !stats.hasErrors() &&
      Boolean(htmlAssets[0] && assets.has(`html:${htmlAssets[0].name}`)) &&
      publicPathSupported,
    publicPathSupported,
  };

  return {
    manifest,
    assets,
    maps,
    originalSources: collectOriginalSources(compilation),
    references,
    codeGeneration: codeGenerationStore.cache,
    loadCodeGeneration: codeGenerationStore.load,
    outputPath: compiler.outputPath,
    indexAsset: htmlAssets[0]?.name ?? null,
  };
}

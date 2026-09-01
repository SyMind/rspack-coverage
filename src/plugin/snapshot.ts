import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { GREATEST_LOWER_BOUND, originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import type { Compiler, Stats } from "@rspack/core";
import { assetUrlPath, normalizeSourcePath } from "../shared/path.js";
import type {
  AnalysisCapabilities,
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
import { collectExportGraph } from "./exportGraph.js";

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

interface RawModuleRecord {
  module: any;
  parent: any | null;
  nested: boolean;
}

function collectRawModuleRecords(compilation: Stats["compilation"]): RawModuleRecord[] {
  const records: RawModuleRecord[] = [];
  const recordsByModule = new WeakMap<object, RawModuleRecord>();
  const visit = (module: any, parent: any | null, nested: boolean): void => {
    if (!module || (typeof module !== "object" && typeof module !== "function")) return;
    const existing = recordsByModule.get(module);
    if (existing) {
      if (nested) {
        existing.nested = true;
        existing.parent ??= parent;
      }
      return;
    }
    const record = { module, parent, nested };
    records.push(record);
    recordsByModule.set(module, record);
    const children = safeCall(() => asArray(module.modules as Iterable<any>), []);
    for (const child of children) visit(child, module, true);
  };
  for (const module of compilation.modules as Iterable<any>) visit(module, null, false);
  return records;
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

interface CapturedModuleSource {
  content: string;
  map: RawSourceMapPayload | null;
  traceMap: TraceMap | null;
  resource: string | null;
  resourceContent: string | null;
}

interface OriginalSourceCapture {
  sources: Map<string, string>;
  capture(module: any, owner: BuildModule | null): CapturedModuleSource | null;
}

function sourceName(map: RawSourceMapPayload, index: number): string {
  const source = map.sources[index] ?? `[unknown source ${index}]`;
  if (!map.sourceRoot || /^(?:webpack|rspack|file):\/\//.test(source)) return source;
  return `${map.sourceRoot.replace(/\/$/, "")}/${source.replace(/^\//, "")}`;
}

function collectOriginalSources(
  records: RawModuleRecord[],
  lookup: Map<string, BuildModule[]>,
): OriginalSourceCapture {
  const sources = new Map<string, string>();
  const captured = new WeakMap<object, CapturedModuleSource | null>();
  const registeredSources = new WeakSet<object>();
  const registeredOwners = new WeakMap<object, Set<string>>();
  const pathsByIdentifier = new Map<string, Set<string>>();

  const capture = (module: any, owner: BuildModule | null): CapturedModuleSource | null => {
    if (!module || (typeof module !== "object" && typeof module !== "function")) return null;
    let result = captured.get(module);
    if (result === undefined) {
      result = safeCall(() => {
        const originalSource = module.originalSource();
        if (!originalSource) return null;
        const sourceAndMap = getSourceAndMap({ source: originalSource });
        const moduleResource = safeCall(() => module.nameForCondition?.() ?? null, null);
        const resource = moduleResource ? String(moduleResource) : (owner?.resource ?? null);
        return {
          content: sourceAndMap.content.toString("utf8"),
          map: sourceAndMap.map,
          traceMap: sourceAndMap.map
            ? safeCall(() => new TraceMap(sourceAndMap.map as any), null)
            : null,
          resource,
          // `originalSource()` is the source entering Rspack after loaders. In
          // production pipelines that source may already be compacted to one
          // line, while dependency locations still describe the real resource.
          // Prefer the local resource text when it is available so reference
          // locations and the source view share the same coordinate system.
          resourceContent:
            resource && isAbsolute(resource)
              ? safeCall(() => readFileSync(resource, "utf8"), null)
              : null,
        };
      }, null);
      captured.set(module, result);
    }
    if (!result) return null;

    if (!registeredSources.has(module)) {
      const map = result.map;
      const identifier = moduleIdentifier(module);
      const knownPaths = pathsByIdentifier.get(identifier) ?? new Set<string>();
      if (map) {
        for (let index = 0; index < map.sources.length; index += 1) {
          const path = sourceName(map, index);
          if (!path || !isAnalyzableSource(path)) continue;
          const mappedContent = map.sourcesContent?.[index];
          const content =
            result.resourceContent && result.resource && sameSourcePath(path, result.resource)
              ? result.resourceContent
              : mappedContent;
          if (typeof content === "string") {
            for (const knownPath of [...knownPaths]) {
              if (knownPath !== path && sameSourcePath(path, knownPath)) {
                sources.delete(knownPath);
                knownPaths.delete(knownPath);
              }
            }
            sources.set(path, content);
            knownPaths.add(path);
          }
        }
      }
      const resource = result.resource;
      const mappedResourceWithContent =
        resource &&
        result.map?.sources.some(
          (_source, index) =>
            typeof result.map?.sourcesContent?.[index] === "string" &&
            sameSourcePath(sourceName(result.map as RawSourceMapPayload, index), resource),
        );
      const resourceAlreadyCaptured =
        resource && [...knownPaths].some((path) => sameSourcePath(path, resource));
      if (
        resource &&
        isAnalyzableSource(resource) &&
        !mappedResourceWithContent &&
        !resourceAlreadyCaptured
      ) {
        if (!sources.has(resource)) sources.set(resource, result.resourceContent ?? result.content);
        knownPaths.add(resource);
      }
      pathsByIdentifier.set(identifier, knownPaths);
      registeredSources.add(module);
    }

    const ownedPaths = owner ? new Set(owner.sourcePaths ?? []) : null;
    const newlyRegistered = registeredOwners.get(module) ?? new Set<string>();
    if (owner && !newlyRegistered.has(owner.id)) {
      if (result.map) {
        for (let index = 0; index < result.map.sources.length; index += 1) {
          const path = sourceName(result.map, index);
          if (path && isAnalyzableSource(path)) ownedPaths?.add(path);
        }
      }
      if (result.resource && isAnalyzableSource(result.resource)) ownedPaths?.add(result.resource);
      if (ownedPaths?.size) owner.sourcePaths = [...ownedPaths];
      newlyRegistered.add(owner.id);
      registeredOwners.set(module, newlyRegistered);
    }
    return result;
  };

  for (const { module } of records) {
    capture(module, buildModuleFor(module, lookup));
  }
  return { sources, capture };
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
      moduleType: String(raw.moduleType ?? raw.type ?? "unknown"),
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
      optimizationBailout: Array.isArray(raw.optimizationBailout)
        ? raw.optimizationBailout.map(String)
        : [],
      nested,
    });

    for (const child of raw.modules ?? []) visit(child, chunks, true);
  };

  for (const raw of rawModules) visit(raw, [], false);
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

function addMissingNestedModules(
  compilation: Stats["compilation"],
  records: RawModuleRecord[],
  modules: BuildModule[],
  entryIdentifiers: Set<string>,
): void {
  const lookup = moduleLookup(modules);
  const rawToBuildModule = new WeakMap<object, BuildModule>();
  const usedIds = new Set(modules.map((module) => module.id));
  for (const record of records) {
    const existing = buildModuleFor(record.module, lookup);
    if (existing) {
      if (record.nested) existing.nested = true;
      rawToBuildModule.set(record.module, existing);
      continue;
    }
    const identifier = moduleIdentifier(record.module);
    const layer = safeCall(() => String(record.module.layer ?? ""), "");
    const type = safeCall(() => String(record.module.type ?? ""), "");
    let duplicate = 0;
    let id = stableModuleId(identifier, layer, type, duplicate);
    while (usedIds.has(id)) {
      duplicate += 1;
      id = stableModuleId(identifier, layer, type, duplicate);
    }
    usedIds.add(id);
    const parent = record.parent ? rawToBuildModule.get(record.parent) : null;
    const rawChunks = safeCall(
      () =>
        asArray((compilation.chunkGraph as any).getModuleChunksIterable(record.module)).map(
          (chunk: any) => String(chunk.id ?? chunk.name ?? "unknown"),
        ),
      [],
    );
    const resource = safeCall(() => record.module.nameForCondition?.() ?? null, null);
    const readableIdentifier = String(
      safeCall(() => record.module.readableIdentifier?.(), null) ?? resource ?? identifier,
    );
    const issuerModule = safeCall(
      () => (compilation.moduleGraph as any).getIssuer(record.module),
      null,
    );
    const providedExports = safeCall(
      () => (compilation.moduleGraph as any).getProvidedExports(record.module),
      null,
    );
    const created: BuildModule = {
      id,
      runtimeId: null,
      identifier,
      readableIdentifier,
      name: readableIdentifier,
      resource: resource ? String(resource) : null,
      moduleType: type || "unknown",
      chunks: rawChunks.length ? rawChunks : (parent?.chunks ?? []),
      issuer: issuerModule ? moduleIdentifier(issuerModule) : null,
      type: type || null,
      layer: layer || null,
      entry: entryIdentifiers.has(identifier),
      size: Number(safeCall(() => record.module.size?.(), 0) ?? 0),
      usedExports: null,
      providedExports: Array.isArray(providedExports) ? providedExports.map(String) : null,
      optimizationBailout: [],
      nested: record.nested,
    };
    modules.push(created);
    rawToBuildModule.set(record.module, created);
    const values = lookup.get(identifier) ?? [];
    values.push(created);
    lookup.set(identifier, values);
  }

  for (const record of records) {
    if (!record.nested || !record.parent) continue;
    const module = rawToBuildModule.get(record.module);
    const parent = rawToBuildModule.get(record.parent);
    const rootModule = safeCall(() => record.parent.rootModule ?? null, null);
    if (
      module &&
      parent?.entry &&
      rootModule &&
      moduleIdentifier(rootModule) === module.identifier
    ) {
      module.entry = true;
    }
  }

  const readableCounts = new Map<string, number>();
  for (const module of modules) {
    const readable = module.readableIdentifier ?? module.name;
    readableCounts.set(readable, (readableCounts.get(readable) ?? 0) + 1);
  }
  for (const module of modules) {
    module.showFullIdentifier =
      (readableCounts.get(module.readableIdentifier ?? module.name) ?? 0) > 1;
  }
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

function tracedSourceName(captured: CapturedModuleSource, resolvedSource: string): string | null {
  if (!captured.map || !captured.traceMap) return null;
  const index = captured.traceMap.resolvedSources.indexOf(resolvedSource);
  return index >= 0 ? sourceName(captured.map, index) : resolvedSource;
}

function sameSourcePath(left: string, right: string): boolean {
  const normalizedLeft = normalizeSourcePath(left);
  const normalizedRight = normalizeSourcePath(right);
  if (normalizedLeft === normalizedRight) return true;
  const [shorter, longer] =
    normalizedLeft.length < normalizedRight.length
      ? [normalizedLeft, normalizedRight]
      : [normalizedRight, normalizedLeft];
  return shorter.includes("/") && longer.endsWith(`/${shorter}`);
}

function traceReferenceLocation(
  captured: CapturedModuleSource | null,
  location: ReferenceLocation | null,
): { sourcePath: string; sourceLocation: ReferenceLocation } | null {
  if (!captured?.traceMap || !location) return null;
  const start = safeCall(
    () =>
      originalPositionFor(captured.traceMap as TraceMap, {
        line: location.start.line,
        column: location.start.column,
        bias: GREATEST_LOWER_BOUND,
      }),
    null,
  );
  if (!start?.source || start.line === null || start.column === null) return null;
  const sourcePath = tracedSourceName(captured, start.source);
  if (!sourcePath || !isAnalyzableSource(sourcePath)) return null;
  // Rspack dependency locations for a module's own resource are already in
  // original-source coordinates. Applying the loader map again double-maps
  // them (notably to line 1 with SWC/Babel chains).
  if (captured.resource && sameSourcePath(sourcePath, captured.resource)) return null;
  const sourceIndex = captured.traceMap.resolvedSources.indexOf(start.source);
  const sourceContent = sourceIndex >= 0 ? captured.map?.sourcesContent?.[sourceIndex] : null;
  if (sourceContent === null || sourceContent === undefined) return null;
  const end = safeCall(
    () =>
      originalPositionFor(captured.traceMap as TraceMap, {
        line: location.end.line,
        column: location.end.column,
        bias: GREATEST_LOWER_BOUND,
      }),
    null,
  );
  const endSource = end?.source ? tracedSourceName(captured, end.source) : null;
  const mappedEnd =
    end && endSource === sourcePath && end.line !== null && end.column !== null
      ? { line: end.line, column: end.column }
      : null;
  const generatedWidth =
    location.start.line === location.end.line
      ? Math.max(1, location.end.column - location.start.column)
      : 1;
  const fallbackEnd = { line: start.line, column: start.column + generatedWidth };
  const sourceEnd =
    mappedEnd &&
    (mappedEnd.line > start.line ||
      (mappedEnd.line === start.line && mappedEnd.column > start.column))
      ? mappedEnd
      : fallbackEnd;
  return {
    sourcePath,
    sourceLocation: {
      start: { line: start.line, column: start.column },
      end: sourceEnd,
    },
  };
}

function collectReferences(
  compilation: Stats["compilation"],
  records: RawModuleRecord[],
  lookup: Map<string, BuildModule[]>,
  originalSources: OriginalSourceCapture,
): BuildReference[] {
  const references: BuildReference[] = [];
  const seen = new Set<string>();
  for (const { module: originModule } of records) {
    const containingOrigin = buildModuleFor(originModule, lookup);
    if (!containingOrigin) continue;
    const connections = safeCall(
      () => asArray((compilation.moduleGraph as any).getOutgoingConnections(originModule)),
      [],
    );
    for (const connection of connections as any[]) {
      const dependency = connection.dependency ?? null;
      const dependencyOriginModule = dependency
        ? safeCall(
            () =>
              (compilation.moduleGraph as any).getParentModule(dependency) ??
              dependency._parentModule ??
              null,
            null,
          )
        : null;
      const graphOriginModule = dependencyOriginModule ?? connection.originModule ?? originModule;
      const origin = buildModuleFor(graphOriginModule, lookup) ?? containingOrigin;
      const targetModule = connection.resolvedModule ?? connection.module;
      const target = targetModule ? buildModuleFor(targetModule, lookup) : null;
      if (!target) continue;
      const dependencyType = dependency?.type ? String(dependency.type) : null;
      const request = dependency?.request ? String(dependency.request) : null;
      const exports = Array.isArray(dependency?.ids) ? dependency.ids.map(String) : null;
      const location = normalizeLocation(dependency?.loc);
      const capturedOrigin = originalSources.capture(graphOriginModule, origin);
      const traced = traceReferenceLocation(capturedOrigin, location);
      const identity = `${origin.id}\0${target.id}\0${dependencyType ?? ""}\0${request ?? ""}\0${JSON.stringify(
        location,
      )}\0${traced?.sourcePath ?? origin.resource ?? ""}\0${JSON.stringify(
        traced?.sourceLocation ?? location,
      )}\0${JSON.stringify(exports)}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const activeState = safeCall(() => connection.getActiveState(undefined), null);
      references.push({
        id: `ref_${shortHash(identity)}`,
        originId: origin.id,
        targetId: target.id,
        dependencyType,
        request,
        exports,
        active: typeof activeState === "boolean" ? activeState : null,
        location,
        sourcePath: traced?.sourcePath ?? origin.resource,
        sourceLocation: traced?.sourceLocation ?? location,
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
  records: RawModuleRecord[],
  lookup: Map<string, BuildModule[]>,
): {
  cache: Map<string, ModuleCodeGeneration[]>;
  load: (moduleId: string) => ModuleCodeGeneration[];
} {
  const rawModules = new Map<string, { raw: any; module: BuildModule }>();
  for (const { module: raw, nested } of records) {
    // Concatenated children do not own code-generation entries. Asking older
    // Rspack bindings for one panics in native code instead of returning null.
    if (nested) continue;
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

function capabilities(compiler: Compiler, sourceMapCount: number): AnalysisCapabilities {
  const usedExports = compiler.options.optimization?.usedExports;
  const devtool = compiler.options.devtool;
  const sourceMap =
    sourceMapCount === 0
      ? "none"
      : typeof devtool === "string" && devtool.includes("cheap")
        ? "line-only"
        : "full";
  return {
    usedExports:
      usedExports === true || usedExports === "global"
        ? "enabled"
        : usedExports === false
          ? "disabled"
          : "unknown",
    sourceMap,
    originalLocations:
      sourceMap === "full" ? "exact" : sourceMap === "line-only" ? "line-only" : "unavailable",
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
  const rawModuleRecords = collectRawModuleRecords(compilation);
  addMissingNestedModules(compilation, rawModuleRecords, modules, entryIdentifiers);
  const modulesByIdentifier = moduleLookup(modules);
  const originalSources = collectOriginalSources(rawModuleRecords, modulesByIdentifier);
  const exportData = collectExportGraph(compilation, modules, compiler.context);
  for (const [source, content] of exportData.originalSources) {
    if (!originalSources.sources.has(source)) originalSources.sources.set(source, content);
  }
  const references = collectReferences(
    compilation,
    rawModuleRecords,
    modulesByIdentifier,
    originalSources,
  );
  const codeGenerationStore = createCodeGenerationStore(
    compilation,
    rawModuleRecords,
    modulesByIdentifier,
  );
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
    capabilities: capabilities(compiler, maps.size),
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
    originalSources: originalSources.sources,
    exportGraph: exportData.graph,
    references,
    codeGeneration: codeGenerationStore.cache,
    loadCodeGeneration: codeGenerationStore.load,
    outputPath: compiler.outputPath,
    indexAsset: htmlAssets[0]?.name ?? null,
  };
}

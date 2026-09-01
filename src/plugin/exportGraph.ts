import type { Stats } from "@rspack/core";
import { normalizeSourcePathForContext } from "../shared/path.js";
import type {
  BuildModule,
  ExportGraphModule,
  ExportGraphSnapshot,
  ExportReferenceEdge,
  RawSourceMapPayload,
  SourceRange,
} from "../shared/types.js";

function asText(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf8");
  return String(value ?? "");
}

function parseMap(value: unknown): RawSourceMapPayload | null {
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

function sourceAndMap(module: any): { source: string | null; map: RawSourceMapPayload | null } {
  try {
    const original = module.originalSource?.();
    if (!original) return { source: null, map: null };
    if (typeof original.sourceAndMap === "function") {
      const result = original.sourceAndMap({ columns: true });
      return { source: asText(result.source), map: parseMap(result.map) };
    }
    const source = asText(original.source());
    const map =
      typeof original.map === "function" ? parseMap(original.map({ columns: true })) : null;
    return { source, map };
  } catch {
    return { source: null, map: null };
  }
}

function rootedSource(map: RawSourceMapPayload, source: string): string {
  if (!map.sourceRoot || /^(?:webpack|rspack|file):\/\//.test(source)) return source;
  return `${map.sourceRoot.replace(/\/$/, "")}/${source.replace(/^\//, "")}`;
}

function moduleIdentifier(module: any): string | null {
  try {
    return String(module.identifier());
  } catch {
    return null;
  }
}

function dependencyRange(location: any): SourceRange | null {
  const start = location?.start;
  if (!start || !Number.isFinite(start.line) || !Number.isFinite(start.column)) return null;
  const end = location.end ?? start;
  return {
    start: { line: Number(start.line), column: Number(start.column) },
    end: {
      line: Number.isFinite(end.line) ? Number(end.line) : Number(start.line),
      column: Number.isFinite(end.column) ? Number(end.column) : Number(start.column) + 1,
    },
  };
}

function readProperty<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function normalizeExports(value: unknown): boolean | string[] | null {
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(String);
  return null;
}

function compilationRuntimes(compilation: Stats["compilation"]): string[] {
  const runtimes = new Set<string>();
  for (const chunk of compilation.chunks) {
    for (const runtime of readProperty(() => [...chunk.runtime], [] as string[])) {
      runtimes.add(String(runtime));
    }
  }
  return [...runtimes];
}

function moduleChunks(compilation: Stats["compilation"], module: any): string[] {
  return readProperty(
    () =>
      [...compilation.chunkGraph.getModuleChunksIterable(module)]
        .map((chunk) => chunk.id)
        .filter((id): id is string | number => id !== null)
        .map(String),
    [],
  );
}

function compilationModules(compilation: Stats["compilation"]): any[] {
  const modules: any[] = [];
  const seen = new Set<any>();
  const visit = (module: any) => {
    if (!module || seen.has(module)) return;
    seen.add(module);
    modules.push(module);
    for (const child of readProperty(() => [...(module.modules ?? [])], [] as any[])) visit(child);
  };
  for (const module of compilation.modules) visit(module);
  return modules;
}

export function collectExportGraph(
  compilation: Stats["compilation"],
  statsModules: BuildModule[],
  context: string,
): { graph: ExportGraphSnapshot; originalSources: Map<string, string> } {
  const statsByIdentifier = new Map(statsModules.map((module) => [module.identifier, module]));
  const modules: ExportGraphModule[] = [];
  const modulesByIdentifier = new Map<string, ExportGraphModule>();
  const sourceToModuleIds = new Map<string, Set<string>>();
  const originalSources = new Map<string, string>();
  const moduleGraph = compilation.moduleGraph as any;
  const runtimes = compilationRuntimes(compilation);
  const rawModules = compilationModules(compilation);

  for (const rawModule of rawModules) {
    const id = moduleIdentifier(rawModule);
    if (!id) continue;
    const statsModule = statsByIdentifier.get(id);
    const resource = readProperty(() => rawModule.nameForCondition?.() ?? null, null);
    const captured = sourceAndMap(rawModule);
    const graphUsedExports =
      runtimes.length > 0
        ? normalizeExports(
            readProperty(() => moduleGraph.getUsedExports(rawModule, runtimes), null),
          )
        : null;
    const graphProvidedExports = normalizeExports(
      readProperty(() => moduleGraph.getProvidedExports(rawModule), null),
    );
    const sourceNames: string[] = [];

    if (captured.map) {
      for (let index = 0; index < captured.map.sources.length; index += 1) {
        const rawName = captured.map.sources[index];
        if (!rawName) continue;
        const name = normalizeSourcePathForContext(rootedSource(captured.map, rawName), context);
        sourceNames.push(name);
        const content = captured.map.sourcesContent?.[index];
        if (typeof content === "string") originalSources.set(name, content);
      }
    }
    if (sourceNames.length === 0 && resource) {
      const name = normalizeSourcePathForContext(String(resource), context);
      sourceNames.push(name);
      if (captured.source !== null) originalSources.set(name, captured.source);
    }

    const graphModule: ExportGraphModule = {
      id: statsModule?.id ?? id,
      identifier: id,
      resource: resource ? String(resource) : (statsModule?.resource ?? null),
      moduleType: statsModule?.moduleType ?? "unknown",
      chunks: statsModule?.chunks.length
        ? statsModule.chunks
        : moduleChunks(compilation, rawModule),
      providedExports:
        statsModule?.providedExports ??
        (Array.isArray(graphProvidedExports) ? graphProvidedExports : null),
      usedExports: statsModule?.usedExports ?? graphUsedExports,
      optimizationBailout: statsModule?.optimizationBailout ?? [],
      originalSources: [...new Set(sourceNames)],
      transformedSource: captured.source,
      sourceMap: captured.map,
    };
    modules.push(graphModule);
    modulesByIdentifier.set(id, graphModule);
    for (const source of graphModule.originalSources) {
      const ids = sourceToModuleIds.get(source) ?? new Set<string>();
      ids.add(id);
      sourceToModuleIds.set(source, ids);
    }
  }

  const edges: ExportReferenceEdge[] = [];
  for (const rawModule of rawModules) {
    const originModuleId = moduleIdentifier(rawModule);
    const origin = originModuleId ? modulesByIdentifier.get(originModuleId) : null;
    if (!origin) continue;
    for (const dependency of readProperty(() => [...(rawModule.dependencies ?? [])], [] as any[])) {
      const target = readProperty(() => moduleGraph.getModule(dependency), null);
      const targetModuleId = target ? moduleIdentifier(target) : null;
      const targetModule = targetModuleId ? modulesByIdentifier.get(targetModuleId) : null;
      if (!targetModule) continue;
      const resolved = readProperty(() => moduleGraph.getResolvedModule(dependency), null);
      const resolvedIdentifier = resolved ? moduleIdentifier(resolved) : null;
      const connection = readProperty(() => moduleGraph.getConnection(dependency), null);
      const activeState = connection
        ? readProperty(() => connection.getActiveState(undefined), true)
        : false;
      const ids = readProperty(() => dependency.ids, undefined);
      edges.push({
        originModuleId: origin.id,
        targetModuleId: targetModule.id,
        resolvedModuleId: resolvedIdentifier
          ? (modulesByIdentifier.get(resolvedIdentifier)?.id ?? null)
          : null,
        dependencyType: String(readProperty(() => dependency.type, "unknown")),
        request: readProperty(() => dependency.request ?? null, null),
        referencedPath: Array.isArray(ids) ? ids.map(String) : null,
        location: dependencyRange(readProperty(() => dependency.loc, null)),
        active: activeState !== false,
      });
    }
  }

  return {
    graph: {
      modules,
      edges,
      sourceToModuleIds: Object.fromEntries(
        [...sourceToModuleIds].map(([source, ids]) => [source, [...ids]]),
      ),
    },
    originalSources,
  };
}

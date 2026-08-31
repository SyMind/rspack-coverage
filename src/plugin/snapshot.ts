import { createHash } from "node:crypto";
import type { Compiler, Stats } from "@rspack/core";
import { assetUrlPath } from "../shared/path.js";
import type {
  BuildAsset,
  BuildChunk,
  BuildDiagnostic,
  BuildEntrypoint,
  BuildManifest,
  BuildModule,
  BuildSnapshot,
  RawSourceMapPayload,
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

function collectModules(rawModules: any[]): BuildModule[] {
  const modules: BuildModule[] = [];
  const seen = new Map<string, number>();

  const visit = (raw: any, inheritedChunks: string[], nested: boolean): void => {
    const identifier = String(raw.identifier ?? raw.name ?? "[unknown module]");
    const baseId = String(raw.id ?? shortHash(identifier));
    const duplicateIndex = seen.get(baseId) ?? 0;
    seen.set(baseId, duplicateIndex + 1);
    const id = duplicateIndex === 0 ? baseId : `${baseId}:${duplicateIndex}`;
    const chunks = (raw.chunks?.length ? raw.chunks : inheritedChunks).map(String);
    const resource = raw.nameForCondition ? String(raw.nameForCondition) : null;

    modules.push({
      id,
      identifier,
      name: String(raw.name ?? resource ?? identifier),
      resource,
      chunks,
      issuer: raw.issuerName ? String(raw.issuerName) : null,
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
  return modules;
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
  privateMaps: Map<string, RawSourceMapPayload> = new Map(),
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
    optimizationBailout: true,
    errors: true,
    warnings: true,
    errorDetails: true,
  } as any) as any;

  const publicPath = getPublicPath(compiler, json);
  const publicPathSupported = !/^https?:\/\//i.test(publicPath) && !publicPath.startsWith("//");
  const statsAssets = new Map((json.assets ?? []).map((asset: any) => [asset.name, asset]));
  const emittedMaps = new Map<string, RawSourceMapPayload>();
  for (const asset of compilation.getAssets()) {
    if (!asset.name.endsWith(".map")) continue;
    const parsed = parseSourceMap(asBuffer(asset.source.source()).toString("utf8"));
    if (parsed) emittedMaps.set(asset.name, parsed);
  }
  const assets = new Map<string, Buffer>();
  const maps = new Map<string, RawSourceMapPayload>();
  const manifestAssets: BuildAsset[] = [];

  for (const asset of compilation.getAssets()) {
    if (!JAVASCRIPT_ASSET_RE.test(asset.name)) continue;
    const sourceAndMap = getSourceAndMap(asset);
    const relatedMapName = (asset.info as any).related?.sourceMap;
    const sourceMap =
      sourceAndMap.map ??
      privateMaps.get(asset.name) ??
      (typeof relatedMapName === "string" ? emittedMaps.get(relatedMapName) : null) ??
      emittedMaps.get(`${asset.name}.map`) ??
      null;
    const content = sourceAndMap.content;
    const id = shortHash(`${asset.name}:${shortHash(content)}`);
    const statsAsset = statsAssets.get(asset.name) as any;
    assets.set(id, content);
    if (sourceMap) maps.set(id, sourceMap);
    manifestAssets.push({
      id,
      name: asset.name,
      urlPath: assetUrlPath(publicPath, asset.name),
      size: content.byteLength,
      contentHash: shortHash(content),
      chunks: (statsAsset?.chunks ?? []).map(String),
      mapAvailable: Boolean(sourceMap),
    });
  }

  const modules = collectModules(json.modules ?? []);
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
    assets.set(`html:${asset.name}`, asBuffer(asset.source.source()));
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
    },
    previewAvailable: !stats.hasErrors() && Boolean(htmlAssets[0]) && publicPathSupported,
    publicPathSupported,
  };

  return {
    manifest,
    assets,
    maps,
    originalSources: collectOriginalSources(compilation),
    outputPath: compiler.outputPath,
    indexAsset: htmlAssets[0]?.name ?? null,
  };
}

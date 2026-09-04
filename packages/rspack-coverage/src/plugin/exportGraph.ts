import type { Stats } from "@rspack/core";
import type { BuildModule, ExportGraphSnapshot } from "../shared/types.js";

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

function moduleIdentifier(module: any): string | null {
  try {
    return String(module.identifier());
  } catch {
    return null;
  }
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

/**
 * Fill gaps in the manifest's export-usage metadata directly. Source text and
 * loader maps live in the original-source store, while BuildReference is the
 * canonical dependency ledger. A second module/edge graph duplicated all
 * three data families on large builds.
 */
export function collectExportGraph(
  compilation: Stats["compilation"],
  statsModules: BuildModule[],
): ExportGraphSnapshot {
  const statsByIdentifier = new Map(statsModules.map((module) => [module.identifier, module]));
  const moduleGraph = compilation.moduleGraph as any;
  const runtimes = compilationRuntimes(compilation);

  for (const rawModule of compilationModules(compilation)) {
    const identifier = moduleIdentifier(rawModule);
    if (!identifier) continue;
    const statsModule = statsByIdentifier.get(identifier);
    if (!statsModule) continue;
    const graphUsedExports =
      runtimes.length > 0
        ? normalizeExports(
            readProperty(() => moduleGraph.getUsedExports(rawModule, runtimes), null),
          )
        : null;
    const graphProvidedExports = normalizeExports(
      readProperty(() => moduleGraph.getProvidedExports(rawModule), null),
    );
    statsModule.providedExports ??= Array.isArray(graphProvidedExports)
      ? graphProvidedExports
      : null;
    statsModule.usedExports ??= graphUsedExports;
  }

  return {
    modules: [],
    edges: [],
    sourceToModuleIds: {},
  };
}

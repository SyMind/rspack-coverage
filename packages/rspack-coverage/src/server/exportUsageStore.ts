import type { ExportUsageEdge, ExportUsageStore } from "../shared/types.js";

function targetKey(moduleId: string, exportPath: readonly string[]): string {
  return `${moduleId}\0${JSON.stringify(exportPath)}`;
}

export function createInMemoryExportUsageStore(
  edges: readonly ExportUsageEdge[],
): ExportUsageStore {
  const byId = new Map(edges.map((edge) => [edge.id, edge]));
  const byTarget = new Map<string, ExportUsageEdge[]>();
  for (const edge of edges) {
    if (!edge.targetExport) continue;
    for (let length = 1; length <= edge.targetExport.length; length += 1) {
      const key = targetKey(edge.targetModuleId, edge.targetExport.slice(0, length));
      const values = byTarget.get(key) ?? [];
      values.push(edge);
      byTarget.set(key, values);
    }
  }
  return {
    size: byId.size,
    get: (id) => byId.get(id),
    countTarget: (moduleId, exportPath) =>
      byTarget.get(targetKey(moduleId, exportPath))?.length ?? 0,
    pageTarget: (moduleId, exportPath, cursor, limit) =>
      (byTarget.get(targetKey(moduleId, exportPath)) ?? []).slice(cursor, cursor + limit),
    *entries() {
      yield* edges;
    },
  };
}

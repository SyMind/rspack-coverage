import type { BuildReference, BuildReferenceStore, ReferenceDirection } from "../shared/types.js";

export function createInMemoryReferenceStore(
  references: readonly BuildReference[],
): BuildReferenceStore {
  const byId = new Map(references.map((reference) => [reference.id, reference]));
  const incoming = new Map<string, BuildReference[]>();
  const outgoing = new Map<string, BuildReference[]>();
  for (const reference of references) {
    const target = incoming.get(reference.targetId) ?? [];
    target.push(reference);
    incoming.set(reference.targetId, target);
    const origin = outgoing.get(reference.originId) ?? [];
    origin.push(reference);
    outgoing.set(reference.originId, origin);
  }

  const records = (moduleId: string, direction: ReferenceDirection): BuildReference[] => {
    if (direction === "in") return incoming.get(moduleId) ?? [];
    if (direction === "out") return outgoing.get(moduleId) ?? [];
    const merged = new Map<string, BuildReference>();
    for (const reference of incoming.get(moduleId) ?? []) merged.set(reference.id, reference);
    for (const reference of outgoing.get(moduleId) ?? []) merged.set(reference.id, reference);
    return [...merged.values()];
  };

  return {
    size: byId.size,
    get: (id) => byId.get(id),
    count: (moduleId, direction) => records(moduleId, direction).length,
    page: (moduleId, direction, cursor, limit) =>
      records(moduleId, direction).slice(cursor, cursor + limit),
    incomingOrigins: (moduleId) => [
      ...new Set((incoming.get(moduleId) ?? []).map((reference) => reference.originId)),
    ],
    countTargets: (targetModuleIds) =>
      [...targetModuleIds].reduce(
        (total, moduleId) => total + (incoming.get(moduleId)?.length ?? 0),
        0,
      ),
    forTargets: (targetModuleIds) =>
      [...targetModuleIds].flatMap((moduleId) => incoming.get(moduleId) ?? []),
    *entries() {
      yield* references;
    },
  };
}

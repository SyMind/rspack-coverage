export { default } from "./loader.js";
export {
  builtInStarExportAdapters,
  createStarExportPlan,
  renderStarExportEntry,
  renderStarExportFacade,
} from "./transform.js";
export type {
  BuiltInAdapterName,
  NamespaceMemberMatch,
  NamespaceRuntimeAdapter,
  NamespaceRuntimeAdapterContext,
  NamespaceRuntimeCandidate,
  NormalizedAdapterOptions,
  StarExportDiagnostic,
  StarExportFacade,
  StarExportFacadeMember,
  StarExportLoaderOptions,
  StarExportPlan,
  StarExportSourceMap,
  StarExportTransformOptions,
} from "./types.js";

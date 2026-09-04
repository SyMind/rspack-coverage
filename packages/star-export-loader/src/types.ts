import type { Identifier, Program, Statement } from "@babel/types";

export type BuiltInAdapterName = "rollup" | "esbuild" | "rolldown";

export interface NamespaceMemberMatch {
  exportedName: string;
  localName: string;
}

export interface NamespaceRuntimeCandidate {
  adapter: string;
  namespaceLocal: string;
  declarationIdentifier: Identifier;
  members: readonly NamespaceMemberMatch[];
  removeStatements: readonly Statement[];
  allowedNamespaceReferences: readonly Identifier[];
  requiredUnshadowedGlobals?: readonly string[];
}

export interface NormalizedAdapterOptions {
  esbuildHelperNames: ReadonlySet<string>;
  rolldownHelperNames: ReadonlySet<string>;
}

export interface NamespaceRuntimeAdapterContext {
  source: string;
  program: Program;
  options: NormalizedAdapterOptions;
}

export interface NamespaceRuntimeAdapter {
  name: string;
  findCandidates(context: NamespaceRuntimeAdapterContext): readonly NamespaceRuntimeCandidate[];
}

export interface StarExportTransformOptions {
  adapters?: readonly (BuiltInAdapterName | NamespaceRuntimeAdapter)[];
  esbuildHelperNames?: readonly string[];
  rolldownHelperNames?: readonly string[];
  filename?: string;
}

export interface StarExportLoaderOptions {
  adapters?: readonly BuiltInAdapterName[];
  esbuildHelperNames?: readonly string[];
  rolldownHelperNames?: readonly string[];
}

export interface StarExportDiagnostic {
  code:
    | "parse-error"
    | "ambiguous-runtime"
    | "missing-export"
    | "unsupported-export-name"
    | "unexpected-namespace-reference"
    | "reassigned-namespace"
    | "unbounded-export-star";
  message: string;
  adapter?: string;
  namespaceLocal?: string;
}

export interface StarExportFacadeMember extends NamespaceMemberMatch {
  virtualExportName: string;
}

export interface StarExportFacade {
  id: number;
  adapter: string;
  namespaceLocal: string;
  namespaceExports: readonly string[];
  members: readonly StarExportFacadeMember[];
}

export interface StarExportSourceMap {
  version: 3;
  file: string;
  sources: string[];
  sourcesContent?: string[];
  names: string[];
  mappings: string;
}

export interface StarExportPlan {
  transformed: boolean;
  fingerprint: string;
  virtualEntrySource: string;
  virtualEntryMap?: StarExportSourceMap;
  facades: readonly StarExportFacade[];
  remainingExports: readonly string[];
  diagnostics: readonly StarExportDiagnostic[];
}

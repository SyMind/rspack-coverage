import { createHash } from "node:crypto";
import { parse } from "@babel/parser";
import traverseImport, { type NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import MagicString from "magic-string";
import { esbuildAdapter } from "./adapters/esbuild.js";
import { rolldownAdapter } from "./adapters/rolldown.js";
import { rollupAdapter } from "./adapters/rollup.js";
import type {
  BuiltInAdapterName,
  NamespaceRuntimeAdapter,
  NamespaceRuntimeCandidate,
  StarExportDiagnostic,
  StarExportFacade,
  StarExportFacadeMember,
  StarExportPlan,
  StarExportSourceMap,
  StarExportTransformOptions,
} from "./types.js";

const BUILT_IN_ADAPTERS: Record<BuiltInAdapterName, NamespaceRuntimeAdapter> = {
  rollup: rollupAdapter,
  esbuild: esbuildAdapter,
  rolldown: rolldownAdapter,
};

const traverse: typeof traverseImport =
  typeof traverseImport === "function"
    ? traverseImport
    : (traverseImport as unknown as { default: typeof traverseImport }).default;

interface NamespaceExportSpecifier {
  declaration: t.ExportNamedDeclaration;
  specifier: t.ExportSpecifier;
  exportedName: string;
}

interface AcceptedCandidate {
  candidate: NamespaceRuntimeCandidate;
  namespaceSpecifiers: readonly NamespaceExportSpecifier[];
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function exportedName(node: t.Identifier | t.StringLiteral): string {
  return t.isIdentifier(node) ? node.name : node.value;
}

function canRenderExportName(name: string): boolean {
  return name === "default" || t.isValidIdentifier(name, false);
}

function renderExportName(name: string): string {
  if (!canRenderExportName(name)) {
    throw new Error(`Unsupported module export name: ${JSON.stringify(name)}`);
  }
  return name;
}

function renderExportSpecifier(localName: string, publicName: string): string {
  const renderedPublicName = renderExportName(publicName);
  return localName === publicName ? localName : `${localName} as ${renderedPublicName}`;
}

function resolveAdapters(
  requested: StarExportTransformOptions["adapters"],
): readonly NamespaceRuntimeAdapter[] {
  const adapters = requested ?? (["rollup", "esbuild", "rolldown"] as const);
  const resolved: NamespaceRuntimeAdapter[] = [];
  const seen = new Set<NamespaceRuntimeAdapter>();
  for (const adapter of adapters) {
    const implementation =
      typeof adapter === "string" ? BUILT_IN_ADAPTERS[adapter as BuiltInAdapterName] : adapter;
    if (!implementation) {
      throw new TypeError(`Unknown star-export runtime adapter: ${String(adapter)}`);
    }
    if (!seen.has(implementation)) {
      resolved.push(implementation);
      seen.add(implementation);
    }
  }
  return resolved;
}

function namespaceExportSpecifiers(
  program: t.Program,
  namespaceLocal: string,
): readonly NamespaceExportSpecifier[] {
  const matches: NamespaceExportSpecifier[] = [];
  for (const statement of program.body) {
    if (
      !t.isExportNamedDeclaration(statement) ||
      statement.source ||
      statement.exportKind === "type"
    ) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (
        t.isExportSpecifier(specifier) &&
        specifier.exportKind !== "type" &&
        t.isIdentifier(specifier.local, { name: namespaceLocal })
      ) {
        matches.push({
          declaration: statement,
          specifier,
          exportedName: exportedName(specifier.exported),
        });
      }
    }
  }
  return matches;
}

function getProgramPath(ast: t.File): NodePath<t.Program> {
  let result: NodePath<t.Program> | undefined;
  traverse(ast, {
    Program(path) {
      result = path;
    },
  });
  if (!result) {
    throw new Error("Unable to initialize the Babel program scope");
  }
  return result;
}

function hasUnboundedExportStar(program: t.Program): boolean {
  return program.body.some((statement) => t.isExportAllDeclaration(statement));
}

function candidateHasValidReferences(
  programPath: NodePath<t.Program>,
  accepted: AcceptedCandidate,
  diagnostics: StarExportDiagnostic[],
): boolean {
  const { candidate, namespaceSpecifiers } = accepted;
  for (const globalName of candidate.requiredUnshadowedGlobals ?? []) {
    if (programPath.scope.getBinding(globalName)) {
      diagnostics.push({
        code: "unexpected-namespace-reference",
        adapter: candidate.adapter,
        namespaceLocal: candidate.namespaceLocal,
        message: `${candidate.adapter} candidate ${candidate.namespaceLocal} uses a shadowed ${globalName} binding.`,
      });
      return false;
    }
  }
  const binding = programPath.scope.getBinding(candidate.namespaceLocal);
  if (!binding || binding.identifier !== candidate.declarationIdentifier) {
    diagnostics.push({
      code: "unexpected-namespace-reference",
      adapter: candidate.adapter,
      namespaceLocal: candidate.namespaceLocal,
      message: `${candidate.adapter} candidate ${candidate.namespaceLocal} is not a single top-level binding.`,
    });
    return false;
  }
  if (binding.constantViolations.length > 0) {
    diagnostics.push({
      code: "reassigned-namespace",
      adapter: candidate.adapter,
      namespaceLocal: candidate.namespaceLocal,
      message: `Namespace binding ${candidate.namespaceLocal} is reassigned after initialization.`,
    });
    return false;
  }

  const allowed = new Set<t.Node>([
    ...candidate.allowedNamespaceReferences,
    ...namespaceSpecifiers.map(({ specifier }) => specifier.local),
  ]);
  const unexpected = binding.referencePaths.find((path) => !allowed.has(path.node));
  if (unexpected) {
    diagnostics.push({
      code: "unexpected-namespace-reference",
      adapter: candidate.adapter,
      namespaceLocal: candidate.namespaceLocal,
      message: `Namespace binding ${candidate.namespaceLocal} is referenced outside its runtime initializer and export declaration.`,
    });
    return false;
  }
  return true;
}

function setPublicExportOwner(
  owners: Map<string, string | null>,
  publicName: string,
  localName: string | null,
): void {
  if (!owners.has(publicName)) {
    owners.set(publicName, localName);
    return;
  }
  if (owners.get(publicName) !== localName) {
    owners.set(publicName, null);
  }
}

function collectPublicExportOwners(
  program: t.Program,
  removedSpecifiers: ReadonlySet<t.ExportSpecifier>,
): ReadonlyMap<string, string | null> {
  const owners = new Map<string, string | null>();
  for (const statement of program.body) {
    if (t.isExportDefaultDeclaration(statement)) {
      setPublicExportOwner(owners, "default", null);
      continue;
    }
    if (!t.isExportNamedDeclaration(statement) || statement.exportKind === "type") {
      continue;
    }
    if (statement.declaration) {
      for (const name of Object.keys(t.getBindingIdentifiers(statement.declaration))) {
        setPublicExportOwner(owners, name, name);
      }
    }
    for (const specifier of statement.specifiers) {
      if (
        t.isExportSpecifier(specifier) &&
        specifier.exportKind !== "type" &&
        !removedSpecifiers.has(specifier)
      ) {
        setPublicExportOwner(
          owners,
          exportedName(specifier.exported),
          !statement.source && t.isIdentifier(specifier.local) ? specifier.local.name : null,
        );
      } else if (t.isExportNamespaceSpecifier(specifier)) {
        setPublicExportOwner(owners, exportedName(specifier.exported), null);
      }
    }
  }
  return owners;
}

function nodeRange(node: t.Node): { start: number; end: number } | undefined {
  return node.start === null ||
    node.start === undefined ||
    node.end === null ||
    node.end === undefined
    ? undefined
    : { start: node.start, end: node.end };
}

function buildVirtualEntry(
  source: string,
  filename: string,
  accepted: readonly AcceptedCandidate[],
  facadeMembers: readonly (readonly StarExportFacadeMember[])[],
  remainingExportOwners: ReadonlyMap<string, string | null>,
): { source: string; map: StarExportSourceMap } {
  const magic = new MagicString(source);
  const removedStatements = new Set<t.Statement>();
  for (const { candidate } of accepted) {
    for (const statement of candidate.removeStatements) {
      if (removedStatements.has(statement)) {
        continue;
      }
      const range = nodeRange(statement);
      if (!range) {
        throw new Error(`Missing source range for ${candidate.adapter} runtime statement`);
      }
      magic.remove(range.start, range.end);
      removedStatements.add(statement);
    }
  }

  const removedSpecifiers = new Set(
    accepted.flatMap(({ namespaceSpecifiers }) =>
      namespaceSpecifiers.map(({ specifier }) => specifier),
    ),
  );
  const rewrittenDeclarations = new Set<t.ExportNamedDeclaration>();
  for (const { namespaceSpecifiers } of accepted) {
    for (const { declaration } of namespaceSpecifiers) {
      if (rewrittenDeclarations.has(declaration)) {
        continue;
      }
      const range = nodeRange(declaration);
      if (!range) {
        throw new Error("Missing source range for namespace export declaration");
      }
      const remaining = declaration.specifiers.filter(
        (specifier) => !t.isExportSpecifier(specifier) || !removedSpecifiers.has(specifier),
      );
      if (remaining.length === 0) {
        magic.remove(range.start, range.end);
      } else {
        const rendered = remaining.map((specifier) => {
          const specifierRange = nodeRange(specifier);
          if (!specifierRange) {
            throw new Error("Missing source range for a retained export specifier");
          }
          return source.slice(specifierRange.start, specifierRange.end);
        });
        magic.overwrite(range.start, range.end, `export { ${rendered.join(", ")} };`);
      }
      rewrittenDeclarations.add(declaration);
    }
  }

  const injected = new Map<string, string>();
  for (const members of facadeMembers) {
    for (const member of members) {
      if (remainingExportOwners.get(member.virtualExportName) === member.localName) {
        continue;
      }
      injected.set(member.virtualExportName, member.localName);
    }
  }
  if (injected.size > 0) {
    const specifiers = [...injected].map(([publicName, localName]) =>
      renderExportSpecifier(localName, publicName),
    );
    magic.append(`\nexport { ${specifiers.join(", ")} };\n`);
  }

  const generatedMap = magic.generateMap({
    file: filename,
    hires: true,
    source: filename,
    includeContent: true,
  });
  return {
    source: magic.toString(),
    map: JSON.parse(generatedMap.toString()) as StarExportSourceMap,
  };
}

function assignFacadeMembers(
  accepted: readonly AcceptedCandidate[],
  remainingExportOwners: ReadonlyMap<string, string | null>,
): readonly (readonly StarExportFacadeMember[])[] {
  const owners = new Map(remainingExportOwners);

  let generatedIndex = 0;
  return accepted.map(({ candidate }) =>
    candidate.members.map((member) => {
      let virtualExportName = member.exportedName;
      const existingOwner = owners.get(virtualExportName);
      if (owners.has(virtualExportName) && existingOwner !== member.localName) {
        do {
          virtualExportName = `__star_export_${generatedIndex++}`;
        } while (owners.has(virtualExportName));
      }
      owners.set(virtualExportName, member.localName);
      return { ...member, virtualExportName };
    }),
  );
}

export function createStarExportPlan(
  source: string,
  options: StarExportTransformOptions = {},
): StarExportPlan {
  const diagnostics: StarExportDiagnostic[] = [];
  let ast: t.File;
  try {
    ast = parse(source, {
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      plugins: ["jsx", "typescript"],
    }) as unknown as t.File;
  } catch (error) {
    diagnostics.push({
      code: "parse-error",
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      transformed: false,
      fingerprint: fingerprint(source),
      virtualEntrySource: source,
      facades: [],
      remainingExports: [],
      diagnostics,
    };
  }

  const context = {
    source,
    program: ast.program,
    options: {
      esbuildHelperNames: new Set(["__export", ...(options.esbuildHelperNames ?? [])]),
      rolldownHelperNames: new Set(["__exportAll", ...(options.rolldownHelperNames ?? [])]),
    },
  };
  const candidates = resolveAdapters(options.adapters)
    .flatMap((adapter) => adapter.findCandidates(context))
    .sort((left, right) => {
      const leftStart = Math.min(...left.removeStatements.map((statement) => statement.start ?? 0));
      const rightStart = Math.min(
        ...right.removeStatements.map((statement) => statement.start ?? 0),
      );
      return leftStart - rightStart;
    });
  const byNamespace = new Map<string, NamespaceRuntimeCandidate[]>();
  for (const candidate of candidates) {
    const entries = byNamespace.get(candidate.namespaceLocal) ?? [];
    entries.push(candidate);
    byNamespace.set(candidate.namespaceLocal, entries);
  }

  const preliminary: AcceptedCandidate[] = [];
  for (const [namespaceLocal, entries] of byNamespace) {
    if (entries.length !== 1) {
      diagnostics.push({
        code: "ambiguous-runtime",
        namespaceLocal,
        message: `Multiple runtime adapters matched namespace binding ${namespaceLocal}.`,
      });
      continue;
    }
    const candidate = entries[0];
    if (!candidate) {
      continue;
    }
    const specifiers = namespaceExportSpecifiers(ast.program, namespaceLocal);
    if (specifiers.length === 0) {
      diagnostics.push({
        code: "missing-export",
        adapter: candidate.adapter,
        namespaceLocal,
        message: `Runtime namespace ${namespaceLocal} is not published by a local ESM export specifier.`,
      });
      continue;
    }
    if (
      specifiers.some(
        ({ exportedName: name }) => name === "default" || !canRenderExportName(name),
      ) ||
      candidate.members.some(({ exportedName: name }) => !canRenderExportName(name))
    ) {
      diagnostics.push({
        code: "unsupported-export-name",
        adapter: candidate.adapter,
        namespaceLocal,
        message: `Runtime namespace ${namespaceLocal} contains an export name that cannot be rendered safely.`,
      });
      continue;
    }
    preliminary.push({ candidate, namespaceSpecifiers: specifiers });
  }
  preliminary.sort(
    (left, right) =>
      (left.namespaceSpecifiers[0]?.specifier.start ?? 0) -
      (right.namespaceSpecifiers[0]?.specifier.start ?? 0),
  );

  if (preliminary.length > 0 && hasUnboundedExportStar(ast.program)) {
    diagnostics.push({
      code: "unbounded-export-star",
      message:
        "The module contains export * from, so promoted facade members cannot be hidden reliably.",
    });
    return {
      transformed: false,
      fingerprint: fingerprint(source),
      virtualEntrySource: source,
      facades: [],
      remainingExports: [],
      diagnostics,
    };
  }

  const programPath = getProgramPath(ast);
  const accepted = preliminary.filter((candidate) =>
    candidateHasValidReferences(programPath, candidate, diagnostics),
  );
  if (accepted.length === 0) {
    return {
      transformed: false,
      fingerprint: fingerprint(source),
      virtualEntrySource: source,
      facades: [],
      remainingExports: [...collectPublicExportOwners(ast.program, new Set()).keys()],
      diagnostics,
    };
  }

  const removedSpecifiers = new Set(
    accepted.flatMap(({ namespaceSpecifiers }) =>
      namespaceSpecifiers.map(({ specifier }) => specifier),
    ),
  );
  const remainingExportOwners = collectPublicExportOwners(ast.program, removedSpecifiers);
  const remainingExports = [...remainingExportOwners.keys()];
  if (remainingExports.some((name) => !canRenderExportName(name))) {
    diagnostics.push({
      code: "unsupported-export-name",
      message: "The module contains a public export name that cannot be rendered safely.",
    });
    return {
      transformed: false,
      fingerprint: fingerprint(source),
      virtualEntrySource: source,
      facades: [],
      remainingExports,
      diagnostics,
    };
  }

  const facadeMembers = assignFacadeMembers(accepted, remainingExportOwners);
  const virtualEntry = buildVirtualEntry(
    source,
    options.filename ?? "star-export-loader-input.js",
    accepted,
    facadeMembers,
    remainingExportOwners,
  );
  const facades: StarExportFacade[] = accepted.map(
    ({ candidate, namespaceSpecifiers: specifiers }, index) => {
      const members = facadeMembers[index];
      if (!members) {
        throw new Error(`Missing facade members for ${candidate.namespaceLocal}`);
      }
      return {
        id: index,
        adapter: candidate.adapter,
        namespaceLocal: candidate.namespaceLocal,
        namespaceExports: specifiers.map(({ exportedName: name }) => name),
        members,
      };
    },
  );
  const planFingerprint = fingerprint(
    JSON.stringify({
      source,
      facades,
      remainingExports,
    }),
  );

  return {
    transformed: true,
    fingerprint: planFingerprint,
    virtualEntrySource: virtualEntry.source,
    virtualEntryMap: virtualEntry.map,
    facades,
    remainingExports,
    diagnostics,
  };
}

export function renderStarExportFacade(
  facade: StarExportFacade,
  virtualEntryRequest: string,
): string {
  const specifiers = facade.members.map((member) =>
    renderExportSpecifier(member.virtualExportName, member.exportedName),
  );
  return `export { ${specifiers.join(", ")} } from ${JSON.stringify(virtualEntryRequest)};\n`;
}

export function renderStarExportEntry(
  plan: StarExportPlan,
  virtualEntryRequest: string,
  facadeRequests: readonly string[],
): string {
  if (!plan.transformed || facadeRequests.length !== plan.facades.length) {
    throw new Error("A transformed star-export plan and one request per facade are required");
  }
  const lines: string[] = [];
  for (const [index, facade] of plan.facades.entries()) {
    const request = facadeRequests[index];
    if (!request) {
      throw new Error(`Missing request for star-export facade ${facade.id}`);
    }
    for (const namespaceExport of facade.namespaceExports) {
      lines.push(
        `export * as ${renderExportName(namespaceExport)} from ${JSON.stringify(request)};`,
      );
    }
  }
  if (plan.remainingExports.length > 0) {
    lines.push(
      `export { ${plan.remainingExports.map(renderExportName).join(", ")} } from ${JSON.stringify(virtualEntryRequest)};`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export const builtInStarExportAdapters = {
  rollup: rollupAdapter,
  esbuild: esbuildAdapter,
  rolldown: rolldownAdapter,
} as const;

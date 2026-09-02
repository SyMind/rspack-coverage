import { type ParserPlugin, parse } from "@babel/parser";
import { originalPositionFor, TraceMap } from "@jridgewell/trace-mapping";
import { normalizeSourcePathForContext } from "../shared/path.js";
import type {
  ExportAnalysisInput,
  ExportGraphModule,
  ExportModuleInstance,
  ExportReference,
  ExportUsagePrecision,
  ExportUsageState,
  SourceExportUsage,
  SourceExportUsageReport,
  SourceRange,
} from "../shared/types.js";

const MAX_REFERENCES = 50;

interface ParsedExport {
  id: string;
  exportedName: string;
  localName: string | null;
  range: SourceRange;
  typeOnly: boolean;
}

interface InferredCommonJsUsage {
  names: Set<string>;
  namespace: boolean;
}

type Progress = (phase: string, completed: number, total: number) => void;

function nodeName(node: any): string | null {
  if (!node) return null;
  if (typeof node.name === "string") return node.name;
  if (typeof node.value === "string") return node.value;
  return null;
}

function nodeRange(node: any): SourceRange | null {
  if (!node?.loc?.start || !node.loc.end) return null;
  return {
    start: { line: node.loc.start.line, column: node.loc.start.column },
    end: { line: node.loc.end.line, column: node.loc.end.column },
  };
}

function bindingIdentifiers(pattern: any): any[] {
  if (!pattern) return [];
  if (pattern.type === "Identifier") return [pattern];
  if (pattern.type === "RestElement") return bindingIdentifiers(pattern.argument);
  if (pattern.type === "AssignmentPattern") return bindingIdentifiers(pattern.left);
  if (pattern.type === "ArrayPattern") return pattern.elements.flatMap(bindingIdentifiers);
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.flatMap((property: any) =>
      property.type === "RestElement"
        ? bindingIdentifiers(property.argument)
        : bindingIdentifiers(property.value),
    );
  }
  return [];
}

function keywordRange(content: string, node: any, keyword: string): SourceRange | null {
  const start = Number(node?.start ?? 0);
  const end = Number(node?.declaration?.start ?? node?.end ?? start);
  const index = content.slice(start, end).indexOf(keyword);
  if (index < 0 || !node?.loc?.start) return null;
  return {
    start: { line: node.loc.start.line, column: node.loc.start.column + index },
    end: { line: node.loc.start.line, column: node.loc.start.column + index + keyword.length },
  };
}

function staticProperty(source: string, member: any): { name: string; range: SourceRange } | null {
  const property = member?.property;
  if (!property) return null;
  if (!member.computed && property.type === "Identifier") {
    const range = nodeRange(property);
    return range ? { name: property.name, range } : null;
  }
  if (
    member.computed &&
    (property.type === "StringLiteral" || property.type === "Literal") &&
    typeof property.value === "string"
  ) {
    const range = nodeRange(property);
    if (!range) return null;
    const raw = source.slice(property.start ?? 0, property.end ?? 0);
    if (
      range.start.line === range.end.line &&
      ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
    ) {
      range.start.column += 1;
      range.end.column -= 1;
    }
    return { name: property.value, range };
  }
  return null;
}

function isModuleExports(node: any): boolean {
  if (node?.type !== "MemberExpression") return false;
  const property = staticProperty("", node);
  return (
    node.object?.type === "Identifier" &&
    node.object.name === "module" &&
    property?.name === "exports"
  );
}

function isCommonJsExportsObject(node: any): boolean {
  return (node?.type === "Identifier" && node.name === "exports") || isModuleExports(node);
}

function commonJsExportMember(
  source: string,
  node: any,
): { name: string; range: SourceRange } | null {
  if (node?.type !== "MemberExpression" || !isCommonJsExportsObject(node.object)) return null;
  return staticProperty(source, node);
}

function isPlaceholderAssignment(node: any): boolean {
  let value = node;
  while (value?.type === "AssignmentExpression" && value.operator === "=") {
    value = value.right;
  }
  return (
    (value?.type === "UnaryExpression" && value.operator === "void") ||
    (value?.type === "Identifier" && value.name === "undefined")
  );
}

function visitAst(node: any, parent: any, visitor: (node: any, parent: any) => void): void {
  if (!node || typeof node !== "object" || typeof node.type !== "string") return;
  visitor(node, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) visitAst(child, node, visitor);
    } else {
      visitAst(value, node, visitor);
    }
  }
}

function requireRequest(node: any): string | null {
  let expression = node;
  while (
    expression?.type === "CallExpression" &&
    expression.arguments?.length === 1 &&
    expression.callee?.type === "Identifier" &&
    (expression.callee.name === "__importStar" || expression.callee.name === "__importDefault")
  ) {
    expression = expression.arguments[0];
  }
  if (
    expression?.type !== "CallExpression" ||
    expression.callee?.type !== "Identifier" ||
    expression.callee.name !== "require"
  ) {
    return null;
  }
  const request = expression.arguments?.[0];
  return request?.type === "StringLiteral" && typeof request.value === "string"
    ? request.value
    : null;
}

function inferCommonJsUsage(source: string): Map<string, InferredCommonJsUsage> {
  let ast: any;
  try {
    ast = parse(source, { sourceType: "unambiguous", errorRecovery: true });
  } catch {
    return new Map();
  }
  const result = new Map<string, InferredCommonJsUsage>();
  const bindings = new Map<string, string>();
  const bindingNodes = new Set<any>();
  const usageFor = (request: string): InferredCommonJsUsage => {
    const existing = result.get(request);
    if (existing) return existing;
    const usage = { names: new Set<string>(), namespace: false };
    result.set(request, usage);
    return usage;
  };

  visitAst(ast.program, null, (node) => {
    if (node.type !== "VariableDeclarator") return;
    const request = requireRequest(node.init);
    if (!request) return;
    const usage = usageFor(request);
    if (node.id?.type === "Identifier") {
      bindings.set(node.id.name, request);
      bindingNodes.add(node.id);
      return;
    }
    if (node.id?.type !== "ObjectPattern") {
      usage.namespace = true;
      return;
    }
    for (const property of node.id.properties ?? []) {
      if (property.type === "RestElement") {
        usage.namespace = true;
        continue;
      }
      const exported = staticProperty(source, {
        property: property.key,
        computed: property.computed,
      });
      if (exported) usage.names.add(exported.name);
      else usage.namespace = true;
    }
  });

  visitAst(ast.program, null, (node, parent) => {
    if (node.type === "MemberExpression") {
      const directRequest = requireRequest(node.object);
      const bindingRequest =
        node.object?.type === "Identifier" ? bindings.get(node.object.name) : undefined;
      const request = directRequest ?? bindingRequest;
      if (request) {
        const usage = usageFor(request);
        const property = staticProperty(source, node);
        if (property) usage.names.add(property.name);
        else usage.namespace = true;
      }
      return;
    }
    if (node.type !== "Identifier" || bindingNodes.has(node)) return;
    const request = bindings.get(node.name);
    if (!request) return;
    if (parent?.type === "MemberExpression") {
      if (parent.object === node) return;
      if (parent.property === node && !parent.computed) return;
    }
    if (parent?.type === "ObjectProperty" && parent.key === node && !parent.computed) {
      if (!parent.shorthand) return;
    }
    usageFor(request).namespace = true;
  });
  return result;
}

function addParsed(
  output: ParsedExport[],
  exportedName: string,
  localName: string | null,
  range: SourceRange | null,
  typeOnly: boolean,
): void {
  if (!range) return;
  output.push({
    id: `${exportedName}:${range.start.line}:${range.start.column}`,
    exportedName,
    localName,
    range,
    typeOnly,
  });
}

export function parseExports(
  source: string,
  path: string,
): {
  exports: ParsedExport[];
  diagnostics: string[];
} {
  const plugins: ParserPlugin[] = ["decorators", "importAttributes", "explicitResourceManagement"];
  if (/\.[cm]?tsx?$/i.test(path)) plugins.push("typescript");
  if (/\.(?:jsx|tsx)$/i.test(path)) plugins.push("jsx");
  const diagnostics: string[] = [];
  let ast: any;
  try {
    ast = parse(source, {
      sourceType: "unambiguous",
      errorRecovery: true,
      plugins,
    });
    for (const error of ast.errors ?? []) diagnostics.push(String(error.message ?? error));
  } catch (error) {
    return {
      exports: [],
      diagnostics: [
        `Could not parse exports: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  const output: ParsedExport[] = [];
  const commonJsExports = new Map<string, { item: ParsedExport; placeholder: boolean }>();
  const addCommonJsExport = (
    exportedName: string,
    localName: string | null,
    range: SourceRange | null,
    placeholder = false,
  ): void => {
    if (!range || exportedName === "__esModule") return;
    const item: ParsedExport = {
      id: `${exportedName}:${range.start.line}:${range.start.column}`,
      exportedName,
      localName,
      range,
      typeOnly: false,
    };
    const previous = commonJsExports.get(exportedName);
    if (!previous || previous.placeholder || !placeholder) {
      commonJsExports.set(exportedName, { item, placeholder });
    }
  };
  const scanCommonJsExpression = (expression: any): void => {
    if (expression?.type === "SequenceExpression") {
      for (const item of expression.expressions ?? []) scanCommonJsExpression(item);
      return;
    }
    if (expression?.type === "AssignmentExpression" && expression.operator === "=") {
      const member = commonJsExportMember(source, expression.left);
      if (member) {
        addCommonJsExport(
          member.name,
          expression.right?.type === "Identifier" ? expression.right.name : null,
          member.range,
          isPlaceholderAssignment(expression.right),
        );
      } else if (
        isModuleExports(expression.left) &&
        expression.right?.type === "ObjectExpression"
      ) {
        for (const property of expression.right.properties ?? []) {
          if (property.type !== "ObjectProperty" && property.type !== "ObjectMethod") continue;
          const exported = staticProperty(source, {
            property: property.key,
            computed: property.computed,
          });
          if (!exported) continue;
          const value = property.type === "ObjectProperty" ? property.value : null;
          addCommonJsExport(
            exported.name,
            value?.type === "Identifier" ? value.name : null,
            exported.range,
          );
        }
      }
      scanCommonJsExpression(expression.right);
      return;
    }
    if (
      expression?.type === "CallExpression" &&
      expression.callee?.type === "MemberExpression" &&
      expression.callee.object?.type === "Identifier" &&
      expression.callee.object.name === "Object" &&
      staticProperty(source, expression.callee)?.name === "defineProperty" &&
      isCommonJsExportsObject(expression.arguments?.[0])
    ) {
      const exported = staticProperty(source, {
        property: expression.arguments?.[1],
        computed: true,
      });
      if (exported) addCommonJsExport(exported.name, null, exported.range);
    }
  };
  for (const statement of ast.program.body ?? []) {
    if (statement.type === "ExportNamedDeclaration") {
      const declaration = statement.declaration;
      const statementTypeOnly = statement.exportKind === "type";
      for (const specifier of statement.specifiers ?? []) {
        const exportedName = nodeName(specifier.exported) ?? nodeName(specifier.local) ?? "*";
        addParsed(
          output,
          exportedName,
          nodeName(specifier.local),
          nodeRange(specifier.exported ?? specifier),
          statementTypeOnly || specifier.exportKind === "type",
        );
      }
      if (!declaration) continue;
      if (declaration.type === "VariableDeclaration") {
        for (const item of declaration.declarations ?? []) {
          for (const identifier of bindingIdentifiers(item.id)) {
            addParsed(output, identifier.name, identifier.name, nodeRange(identifier), false);
          }
        }
      } else if (declaration.id) {
        const name = nodeName(declaration.id);
        if (name) {
          const typeOnly =
            statementTypeOnly ||
            declaration.type === "TSInterfaceDeclaration" ||
            declaration.type === "TSTypeAliasDeclaration" ||
            declaration.type === "TSDeclareFunction";
          addParsed(output, name, name, nodeRange(declaration.id), typeOnly);
        }
      }
    } else if (statement.type === "ExportDefaultDeclaration") {
      const localName = nodeName(statement.declaration?.id);
      addParsed(
        output,
        "default",
        localName,
        localName
          ? nodeRange(statement.declaration.id)
          : keywordRange(source, statement, "default"),
        false,
      );
    } else if (statement.type === "ExportAllDeclaration") {
      const star = keywordRange(
        source,
        { ...statement, declaration: { start: statement.end } },
        "*",
      );
      addParsed(output, "*", null, star ?? nodeRange(statement), false);
    } else if (statement.type === "ExpressionStatement") {
      scanCommonJsExpression(statement.expression);
    }
  }
  output.push(...[...commonJsExports.values()].map(({ item }) => item));
  return { exports: output, diagnostics };
}

function stateForModule(
  module: ExportGraphModule,
  exportName: string,
  hasExactReference: boolean,
  hasNamespaceReference: boolean,
  usedExportsEnabled: boolean,
): Pick<ExportModuleInstance, "state" | "precision"> {
  if (hasExactReference) return { state: "used", precision: "exact" };
  if (hasNamespaceReference) return { state: "used", precision: "conservative" };
  if (!usedExportsEnabled) return { state: "unknown", precision: "unavailable" };
  if (Array.isArray(module.usedExports)) {
    return module.usedExports.includes(exportName)
      ? { state: "used", precision: "exact" }
      : { state: "unused", precision: "exact" };
  }
  if (module.usedExports === true) return { state: "used", precision: "conservative" };
  if (module.usedExports === false) return { state: "unused", precision: "exact" };
  if (module.providedExports?.includes(exportName)) {
    return { state: "unknown", precision: "unavailable" };
  }
  return { state: "unknown", precision: "unavailable" };
}

function stateRank(state: ExportUsageState, precision: ExportUsagePrecision): number {
  if (state === "type-only") return 0;
  if (state === "used" && precision === "exact") return 5;
  if (state === "used") return 4;
  if (state === "unknown") return 3;
  if (state === "unused") return 2;
  return 1;
}

function mapReference(
  input: ExportAnalysisInput,
  origin: ExportGraphModule | null,
  edge: ExportAnalysisInput["references"][number]["edge"],
): ExportReference {
  const rawLine = edge.location?.start.line ?? null;
  const rawColumn = edge.location?.start.column ?? null;
  let path =
    origin?.originalSources[0] ?? origin?.resource ?? origin?.identifier ?? "[unknown module]";
  let line = rawLine;
  let column = rawColumn;
  let snippet: string | null = null;
  let locationPrecision: ExportReference["locationPrecision"] = "unavailable";

  if (edge.originalLocation && edge.sourcePath) {
    path = edge.sourcePath;
    locationPrecision =
      input.originalLocations === "exact"
        ? "exact"
        : input.originalLocations === "line-only"
          ? "line-only"
          : "unavailable";
  } else if (origin?.sourceMap && rawLine !== null && rawColumn !== null) {
    try {
      const traced = originalPositionFor(new TraceMap(origin.sourceMap as any), {
        line: rawLine,
        column: Math.max(0, rawColumn - 1),
      });
      if (traced.source && traced.line !== null) {
        path = normalizeSourcePathForContext(traced.source, input.context);
        line = traced.line;
        column = traced.column === null ? null : traced.column + 1;
        const sourceIndex = origin.sourceMap.sources.findIndex(
          (source) =>
            source === traced.source ||
            normalizeSourcePathForContext(source, input.context) === path,
        );
        const content = sourceIndex >= 0 ? origin.sourceMap.sourcesContent?.[sourceIndex] : null;
        snippet =
          typeof content === "string" ? (content.split(/\r?\n/)[traced.line - 1] ?? null) : null;
        locationPrecision =
          input.originalLocations === "exact"
            ? "exact"
            : input.originalLocations === "line-only"
              ? "line-only"
              : "unavailable";
      }
    } catch {
      // Fall back to the loader-processed location below.
    }
  }
  if (snippet === null && origin?.transformedSource && rawLine !== null) {
    snippet = origin.transformedSource.split(/\r?\n/)[rawLine - 1] ?? null;
  }
  path = normalizeSourcePathForContext(path, input.context);
  return {
    moduleId: origin?.id ?? edge.originModuleId,
    targetModuleId: edge.targetModuleId,
    path,
    line,
    column,
    snippet,
    dependencyType: edge.dependencyType,
    request: edge.request,
    referencedPath: edge.referencedPath,
    locationPrecision,
  };
}

function compareReferences(left: ExportReference, right: ExportReference): number {
  return (
    left.path.localeCompare(right.path) ||
    (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER) ||
    (left.column ?? Number.MAX_SAFE_INTEGER) - (right.column ?? Number.MAX_SAFE_INTEGER)
  );
}

export async function analyzeSourceExports(
  input: ExportAnalysisInput,
  onProgress: Progress = () => undefined,
): Promise<SourceExportUsageReport> {
  onProgress("Parsing exports", 0, 1);
  const parsed = parseExports(input.content, input.source);
  onProgress("Matching Rspack modules", 1, 1);
  const diagnostics = [...parsed.diagnostics];
  if (!input.usedExportsEnabled) {
    diagnostics.push(
      "optimization.usedExports is disabled; unreferenced exports remain unknown instead of unused.",
    );
  }
  if (input.modules.length === 0) {
    diagnostics.push("No Rspack module could be matched to this source.");
  }

  const inferredUsageByOrigin = new Map<string, Map<string, InferredCommonJsUsage>>();
  const inferredUsage = (
    origin: ExportGraphModule | null,
    edge: ExportAnalysisInput["references"][number]["edge"],
  ): InferredCommonJsUsage | null => {
    if (
      edge.referencedPath !== null ||
      !edge.dependencyType.toLowerCase().includes("cjs") ||
      !edge.request ||
      !origin?.transformedSource
    ) {
      return null;
    }
    let byRequest = inferredUsageByOrigin.get(origin.id);
    if (!byRequest) {
      byRequest = inferCommonJsUsage(origin.transformedSource);
      inferredUsageByOrigin.set(origin.id, byRequest);
    }
    return byRequest.get(edge.request) ?? null;
  };

  const exports: SourceExportUsage[] = [];
  for (let index = 0; index < parsed.exports.length; index += 1) {
    const item = parsed.exports[index] as ParsedExport;
    onProgress("Tracing references", index, parsed.exports.length);
    if (item.typeOnly) {
      exports.push({
        ...item,
        state: "type-only",
        precision: "exact",
        moduleInstances: [],
        referenceCount: 0,
        referenceCountByModule: {},
        references: [],
        truncated: false,
      });
      continue;
    }

    const matchingReferences = input.references.flatMap(({ edge, origin }) => {
      if (!edge.active) return [];
      const first = edge.referencedPath?.[0];
      const inferred = inferredUsage(origin, edge);
      const exact = first === item.exportedName || inferred?.names.has(item.exportedName) === true;
      const namespace =
        edge.referencedPath?.length === 0 ||
        (edge.referencedPath === null && (!inferred || inferred.namespace));
      if (!exact && !namespace) return [];
      return [
        {
          edge:
            exact && edge.referencedPath === null
              ? { ...edge, referencedPath: [item.exportedName] }
              : edge,
          origin,
          exact,
          namespace,
        },
      ];
    });
    const exactModuleIds = new Set(
      matchingReferences.filter(({ exact }) => exact).map(({ edge }) => edge.targetModuleId),
    );
    const namespaceModuleIds = new Set(
      matchingReferences
        .filter(({ namespace }) => namespace)
        .map(({ edge }) => edge.targetModuleId),
    );
    const moduleInstances = input.modules.map((module) => {
      const state = stateForModule(
        module,
        item.exportedName,
        exactModuleIds.has(module.id),
        namespaceModuleIds.has(module.id),
        input.usedExportsEnabled,
      );
      return {
        moduleId: module.id,
        identifier: module.identifier,
        resource: module.resource,
        chunks: module.chunks,
        ...state,
        optimizationBailout: module.optimizationBailout,
      } satisfies ExportModuleInstance;
    });
    const aggregate = moduleInstances.length
      ? moduleInstances
          .slice(1)
          .reduce<Pick<ExportModuleInstance, "state" | "precision">>(
            (best, current) =>
              stateRank(current.state, current.precision) > stateRank(best.state, best.precision)
                ? current
                : best,
            moduleInstances[0] as ExportModuleInstance,
          )
      : { state: "unknown" as const, precision: "unavailable" as const };
    const references = matchingReferences
      .map(({ edge, origin }) => mapReference(input, origin, edge))
      .sort(compareReferences);
    const referenceCountByModule = Object.fromEntries(
      moduleInstances.map((module) => [module.moduleId, 0]),
    );
    for (const reference of references) {
      referenceCountByModule[reference.targetModuleId] =
        (referenceCountByModule[reference.targetModuleId] ?? 0) + 1;
    }
    exports.push({
      ...item,
      state: aggregate.state,
      precision: aggregate.precision,
      moduleInstances,
      referenceCount: references.length,
      referenceCountByModule,
      references: references.slice(0, MAX_REFERENCES),
      truncated: references.length > MAX_REFERENCES,
    });
  }
  onProgress("Preparing result", parsed.exports.length, parsed.exports.length);

  return {
    buildHash: input.buildHash,
    source: input.source,
    exports,
    diagnostics,
    directReferencesOnly: true,
    summary: {
      total: exports.length,
      used: exports.filter((item) => item.state === "used").length,
      unused: exports.filter((item) => item.state === "unused").length,
      unknown: exports.filter((item) => item.state === "unknown").length,
      typeOnly: exports.filter((item) => item.state === "type-only").length,
    },
  };
}

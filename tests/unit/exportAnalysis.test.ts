import { describe, expect, it } from "vitest";
import { analyzeSourceExports, parseExports } from "../../src/server/exportAnalysis.js";
import type {
  ExportAnalysisInput,
  ExportGraphModule,
  ExportReferenceEdge,
} from "../../src/shared/types.js";

function graphModule(overrides: Partial<ExportGraphModule> = {}): ExportGraphModule {
  return {
    id: "target",
    identifier: "/project/src/exports.ts",
    resource: "/project/src/exports.ts",
    moduleType: "javascript/esm",
    chunks: ["main"],
    providedExports: ["ACTIONS", "EVENTS", "renamed"],
    usedExports: ["ACTIONS"],
    optimizationBailout: [],
    originalSources: ["src/exports.ts"],
    transformedSource: null,
    sourceMap: null,
    ...overrides,
  };
}

function referenceEdge(overrides: Partial<ExportReferenceEdge> = {}): ExportReferenceEdge {
  return {
    originModuleId: "consumer",
    targetModuleId: "target",
    resolvedModuleId: "target",
    dependencyType: "esm import specifier",
    request: "./exports",
    referencedPath: ["ACTIONS", "next"],
    location: {
      start: { line: 1, column: 1 },
      end: { line: 1, column: 8 },
    },
    active: true,
    ...overrides,
  };
}

function input(overrides: Partial<ExportAnalysisInput> = {}): ExportAnalysisInput {
  const target = graphModule();
  const origin = graphModule({
    id: "consumer",
    identifier: "/project/src/consumer.ts",
    resource: "/project/src/consumer.ts",
    providedExports: [],
    usedExports: [],
    originalSources: ["src/consumer.ts"],
    transformedSource: "ACTIONS.next();",
    sourceMap: {
      version: 3,
      sources: ["/project/src/consumer.ts"],
      sourcesContent: ["ACTIONS.next();"],
      names: [],
      mappings: "AAAA",
    },
  });
  return {
    buildHash: "build",
    context: "/project",
    source: "src/exports.ts",
    content: "export { ACTIONS, EVENTS, local as renamed };",
    modules: [target],
    references: [{ edge: referenceEdge(), origin }],
    usedExportsEnabled: true,
    originalLocations: "exact",
    ...overrides,
  };
}

describe("export usage analysis", () => {
  it("parses named, aliased, declarations, default, re-exports, star, and type-only exports", () => {
    const result = parseExports(
      [
        "const ACTIONS = {};",
        "const local = 1;",
        "type Model = {};",
        "export { ACTIONS, local as publicName };",
        "export const value = 1;",
        "export function run() {}",
        "export class Widget {}",
        "export default function main() {}",
        'export { remote as forwarded } from "./remote";',
        'export * from "./all";',
        "export type { Model };",
        "export interface Shape {}",
        "export type Alias = string;",
      ].join("\n"),
      "src/module.ts",
    );

    expect(result.diagnostics).toEqual([]);
    expect(
      result.exports.map((item) => [item.exportedName, item.localName, item.typeOnly]),
    ).toEqual([
      ["ACTIONS", "ACTIONS", false],
      ["publicName", "local", false],
      ["value", "value", false],
      ["run", "run", false],
      ["Widget", "Widget", false],
      ["default", "main", false],
      ["forwarded", "remote", false],
      ["*", null, false],
      ["Model", "Model", true],
      ["Shape", "Shape", true],
      ["Alias", "Alias", true],
    ]);
  });

  it("combines stats and exact ModuleGraph references without losing an unused result", async () => {
    const report = await analyzeSourceExports(input());
    const actions = report.exports.find((item) => item.exportedName === "ACTIONS");
    const events = report.exports.find((item) => item.exportedName === "EVENTS");
    const renamed = report.exports.find((item) => item.exportedName === "renamed");

    expect(actions).toMatchObject({ state: "used", precision: "exact", referenceCount: 1 });
    expect(actions?.references[0]).toMatchObject({
      path: "src/consumer.ts",
      line: 1,
      column: 1,
      snippet: "ACTIONS.next();",
      referencedPath: ["ACTIONS", "next"],
      locationPrecision: "exact",
    });
    expect(events).toMatchObject({ state: "unused", precision: "exact", referenceCount: 0 });
    expect(renamed).toMatchObject({ state: "unused", precision: "exact", referenceCount: 0 });
  });

  it("degrades unreferenced exports to unknown when usedExports is disabled", async () => {
    const report = await analyzeSourceExports(
      input({
        usedExportsEnabled: false,
        modules: [graphModule({ usedExports: null })],
      }),
    );

    expect(report.exports.find((item) => item.exportedName === "ACTIONS")?.state).toBe("used");
    expect(report.exports.find((item) => item.exportedName === "EVENTS")).toMatchObject({
      state: "unknown",
      precision: "unavailable",
    });
    expect(report.diagnostics.join(" ")).toContain("usedExports is disabled");
  });

  it("marks namespace usage conservative and limits direct reference details", async () => {
    const origin = input().references[0]?.origin ?? null;
    const references = Array.from({ length: 51 }, (_, index) => ({
      edge: referenceEdge({
        referencedPath: null,
        location: {
          start: { line: 1, column: index + 1 },
          end: { line: 1, column: index + 2 },
        },
      }),
      origin,
    }));
    const report = await analyzeSourceExports(
      input({
        modules: [graphModule({ usedExports: null })],
        references,
      }),
    );
    const actions = report.exports.find((item) => item.exportedName === "ACTIONS");

    expect(actions).toMatchObject({
      state: "used",
      precision: "conservative",
      referenceCount: 51,
      truncated: true,
    });
    expect(actions?.references).toHaveLength(50);
  });
});

// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ModuleReferencesResponse,
  SourceExportAnalysisStatus,
  SourceExportUsage,
  SourceFileDetail,
  SourceFileSummary,
} from "../../src/shared/types.js";
import { ReferencePanel } from "../../src/ui/components/ReferencePanel.js";
import { SourceDrawer } from "../../src/ui/components/SourceDrawer.js";

const api = vi.hoisted(() => ({
  loadCoverageSource: vi.fn(),
  loadExportDeclaration: vi.fn(),
  loadExportImporterChain: vi.fn(),
  loadGeneratedSource: vi.fn(),
  loadReferenceSnippet: vi.fn(),
  loadReferences: vi.fn(),
  loadSourceExportStatus: vi.fn(),
  openInEditor: vi.fn(),
}));

vi.mock("../../src/ui/lib/api.js", () => api);

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 24,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        size: 24,
        start: index * 24,
      })),
  }),
}));

afterEach(() => {
  cleanup();
  api.loadCoverageSource.mockReset();
  api.loadExportDeclaration.mockReset();
  api.loadExportImporterChain.mockReset();
  api.loadGeneratedSource.mockReset();
  api.loadReferenceSnippet.mockReset();
  api.loadReferences.mockReset();
  api.loadSourceExportStatus.mockReset();
  api.openInEditor.mockReset();
});

beforeEach(() => {
  history.replaceState(null, "", "/");
  api.loadExportDeclaration.mockRejectedValue(new Error("Declaration fixture unavailable"));
});

const file: SourceFileSummary = {
  id: "src/exports.ts",
  path: "src/exports.ts",
  displayPath: "src/exports.ts",
  category: "first-party",
  metrics: {
    emittedBytes: 20,
    loadedBytes: 20,
    executedBytes: 10,
    unusedBytes: 10,
    notLoadedBytes: 0,
    mappedBytes: 20,
    unmappedBytes: 0,
    usageRatio: 0.5,
  },
  moduleMetrics: {
    emittedBytes: 12,
    loadedBytes: 12,
    executedBytes: 4,
    unusedBytes: 8,
    notLoadedBytes: 0,
    mappedBytes: 12,
    unmappedBytes: 0,
    usageRatio: 1 / 3,
  },
  chunks: ["main"],
  loadedChunks: ["main"],
  moduleIds: ["target"],
  duplicated: false,
};

const detail: SourceFileDetail = {
  id: file.id,
  lines: [
    {
      line: 1,
      text: "export { ACTIONS, EVENTS, NAMESPACE };",
      buildState: "retained",
      runtimeState: "executed",
      emittedBytes: 20,
      loadedBytes: 20,
      executedBytes: 10,
      chunks: ["main"],
      ranges: [{ startColumn: 0, endColumn: 38, executed: true }],
    },
    {
      line: 2,
      text: "const cold = 'unused';",
      buildState: "retained",
      runtimeState: "not-executed",
      emittedBytes: 10,
      loadedBytes: 10,
      executedBytes: 0,
      chunks: ["main"],
      ranges: [{ startColumn: 0, endColumn: 22, executed: false }],
    },
  ],
};

function completeStatus(): SourceExportAnalysisStatus {
  return {
    status: "complete",
    report: {
      buildHash: "build",
      source: file.path,
      diagnostics: [],
      directReferencesOnly: true,
      summary: { total: 3, used: 2, unused: 1, unknown: 0, typeOnly: 0 },
      exports: [
        {
          id: "ACTIONS:1:9",
          exportedName: "ACTIONS",
          localName: "ACTIONS",
          range: { start: { line: 1, column: 9 }, end: { line: 1, column: 16 } },
          state: "used",
          precision: "exact",
          moduleInstances: [
            {
              moduleId: "target",
              identifier: "/project/src/exports.ts",
              resource: "/project/src/exports.ts",
              chunks: ["main"],
              state: "used",
              precision: "exact",
              optimizationBailout: [],
            },
          ],
          referenceCount: 1,
          referenceCountByModule: { target: 1 },
          references: [
            {
              moduleId: "consumer",
              targetModuleId: "target",
              path: "src/consumer.ts",
              line: 4,
              column: 3,
              snippet: "ACTIONS.next();",
              dependencyType: "esm import specifier",
              request: "./exports",
              referencedPath: ["ACTIONS", "next"],
              locationPrecision: "exact",
            },
          ],
          truncated: false,
        },
        {
          id: "EVENTS:1:18",
          exportedName: "EVENTS",
          localName: "EVENTS",
          range: { start: { line: 1, column: 18 }, end: { line: 1, column: 24 } },
          state: "unused",
          precision: "exact",
          moduleInstances: [
            {
              moduleId: "unused-target",
              identifier: "/project/src/exports.ts|unused-instance",
              resource: "/project/src/exports.ts",
              chunks: ["async"],
              state: "unused",
              precision: "exact",
              optimizationBailout: [],
            },
            {
              moduleId: "unused-target-source",
              identifier: "/project/src/exports.ts",
              resource: "/project/src/exports.ts",
              chunks: [],
              state: "unused",
              precision: "exact",
              optimizationBailout: [],
            },
          ],
          referenceCount: 0,
          referenceCountByModule: { "unused-target": 0, "unused-target-source": 0 },
          references: [],
          truncated: false,
        },
        {
          id: "NAMESPACE:1:26",
          exportedName: "NAMESPACE",
          localName: "NAMESPACE",
          range: { start: { line: 1, column: 26 }, end: { line: 1, column: 35 } },
          state: "used",
          precision: "conservative",
          moduleInstances: [],
          referenceCount: 1,
          referenceCountByModule: {},
          references: [],
          truncated: false,
        },
      ],
    },
  };
}

describe("SourceDrawer export usage", () => {
  it("opens a module export graph restored from URL state", async () => {
    const target = {
      id: "target",
      identifier: "/project/src/exports.ts",
      name: "./src/exports.ts",
      resource: "/project/src/exports.ts",
      moduleType: "javascript/auto",
      chunks: ["main"],
      issuer: null,
      size: 20,
      usedExports: ["ACTIONS"],
      providedExports: ["ACTIONS"],
      optimizationBailout: [],
      nested: false,
    };
    const references: ModuleReferencesResponse = {
      module: target,
      direction: "in",
      counts: { in: 0, out: 0, both: 0 },
      total: 0,
      cursor: 0,
      nextCursor: null,
      edges: [],
      entryPath: [],
    };
    api.loadCoverageSource.mockResolvedValue(detail);
    api.loadSourceExportStatus.mockResolvedValue(completeStatus());
    api.loadReferences.mockResolvedValue(references);
    api.loadExportImporterChain.mockResolvedValue({
      module: target,
      exportedName: "ACTIONS",
      binding: { exportedName: "ACTIONS", localName: "ACTIONS" },
      steps: [],
      precision: "native",
      truncated: false,
      maxDepth: 12,
    });

    render(
      <SourceDrawer
        buildHash="build"
        file={file}
        moduleId="target"
        initialExportName="ACTIONS"
        restoreFromUrl
        module={target}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByRole("button", { name: "Export Usage" })).toHaveClass("active");
    expect(screen.getByText("ACTIONS", { selector: ".graph-export-center" })).toBeVisible();
    expect(api.loadReferences).toHaveBeenCalledWith("target", "in");
    expect(api.loadExportImporterChain).toHaveBeenCalledWith("target", "ACTIONS");
  });

  it("opens the exact edge when one importer module has multiple export usages", () => {
    const target = {
      id: "target",
      identifier: "/project/src/target.ts",
      name: "./src/target.ts",
      resource: "/project/src/target.ts",
      moduleType: "javascript/auto",
      chunks: ["main"],
      issuer: null,
      size: 20,
      usedExports: ["default"],
      providedExports: ["default"],
      optimizationBailout: [],
      nested: false,
    };
    const consumer = {
      ...target,
      id: "consumer",
      identifier: "/project/src/consumer.ts",
      name: "./src/consumer.ts",
      resource: "/project/src/consumer.ts",
      usedExports: true,
      providedExports: null,
    };
    const edge = (id: string, line: number, column: number) => ({
      id,
      originId: consumer.id,
      targetId: target.id,
      dependencyType: "esm import specifier",
      request: "./target",
      exports: ["default"],
      active: true,
      location: {
        start: { line, column },
        end: { line, column: column + 7 },
      },
      origin: consumer,
      target,
    });
    const references: ModuleReferencesResponse = {
      module: target,
      direction: "in",
      counts: { in: 2, out: 0, both: 2 },
      total: 2,
      cursor: 0,
      nextCursor: null,
      edges: [edge("edge-21", 21, 18), edge("edge-34", 34, 26)],
      entryPath: [],
    };
    const exportUsage: SourceExportUsage = {
      id: "default:1:1",
      exportedName: "default",
      localName: "withField",
      range: { start: { line: 1, column: 0 }, end: { line: 1, column: 7 } },
      state: "used",
      precision: "exact",
      moduleInstances: [
        {
          moduleId: target.id,
          identifier: target.identifier,
          resource: target.resource,
          chunks: target.chunks,
          state: "used",
          precision: "exact",
          optimizationBailout: [],
        },
      ],
      referenceCount: 2,
      referenceCountByModule: { target: 2 },
      references: [
        {
          moduleId: consumer.id,
          targetModuleId: target.id,
          path: "src/consumer.ts",
          line: 21,
          column: 18,
          snippet: "withField(Input);",
          dependencyType: "esm import specifier",
          request: "./target",
          referencedPath: ["default"],
          locationPrecision: "exact",
        },
        {
          moduleId: consumer.id,
          targetModuleId: target.id,
          path: "src/consumer.ts",
          line: 34,
          column: 26,
          snippet: "withField(Group);",
          dependencyType: "esm import specifier",
          request: "./target",
          referencedPath: ["default"],
          locationPrecision: "exact",
        },
      ],
      truncated: false,
    };
    const onSelectEdge = vi.fn();
    const onSelectCarrier = vi.fn();
    const upstream = {
      ...consumer,
      id: "upstream",
      identifier: "/project/src/index.ts",
      readableIdentifier: "./src/index.ts",
      name: "/project/src/index.ts",
      resource: "/project/src/index.ts",
      usedExports: true,
      providedExports: null,
    };
    const upstreamEdge = {
      ...edge("upstream-edge", 8, 4),
      originId: upstream.id,
      targetId: consumer.id,
      exports: ["createWebSuite"],
      origin: upstream,
      target: consumer,
    };
    const directGraphEdge = references.edges[0];
    if (!directGraphEdge) throw new Error("Expected a direct graph edge fixture.");
    references.graph = {
      direction: "in",
      requestedDepth: 2,
      reachedDepth: 2,
      nodes: [
        { module: target, depth: 0 },
        { module: consumer, depth: -1 },
        { module: upstream, depth: -2 },
      ],
      edges: [
        { ...directGraphEdge, referenceCount: 2 },
        { ...upstreamEdge, referenceCount: 1 },
      ],
      truncated: true,
      truncation: { depth: true, nodes: false, edges: false, perModule: false },
      limits: { maxDepth: 12, maxNodes: 240, maxEdges: 480 },
    };
    const onLoadGraphDepth = vi.fn();
    render(
      <ReferencePanel
        exportUsage={exportUsage}
        moduleInstance={exportUsage.moduleInstances[0] ?? null}
        references={references}
        importerChain={{
          module: target,
          exportedName: "default",
          binding: { exportedName: "default", localName: "withField" },
          truncated: false,
          maxDepth: 12,
          steps: [
            {
              id: "chain-direct",
              parentId: null,
              depth: 1,
              importedExport: "default",
              importedBinding: { exportedName: "default", localName: "withField" },
              importerExports: ["createWebSuite"],
              importerBindings: [{ exportedName: "createWebSuite", localName: "createWebSuite" }],
              relationPrecision: "exact",
              edge: references.edges[0] as NonNullable<(typeof references.edges)[number]>,
            },
            {
              id: "chain-direct-alias",
              parentId: null,
              depth: 1,
              importedExport: "default",
              importedBinding: { exportedName: "default", localName: "withField" },
              importerExports: [],
              importerBindings: [],
              relationPrecision: "exact",
              edge: references.edges[0] as NonNullable<(typeof references.edges)[number]>,
            },
            {
              id: "chain-upstream",
              parentId: "chain-direct",
              depth: 2,
              importedExport: "createWebSuite",
              importedBinding: {
                exportedName: "createWebSuite",
                localName: "createWebSuite",
              },
              importerExports: [],
              importerBindings: [],
              relationPrecision: "unavailable",
              edge: upstreamEdge,
            },
          ],
        }}
        direction="in"
        loading={false}
        error={null}
        snippet={null}
        snippetFlashKey={0}
        onDirectionChange={vi.fn()}
        onSelectEdge={onSelectEdge}
        onSelectCarrier={onSelectCarrier}
        onLoadMore={vi.fn()}
        onLoadGraphDepth={onLoadGraphDepth}
        onModuleChange={vi.fn()}
        onCloseSnippet={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Chain" }));
    const importerButtons = screen.getAllByRole("button", {
      name: "Open importer usage src/consumer.ts",
    });
    fireEvent.click(importerButtons[0] as HTMLElement);
    fireEvent.click(importerButtons[1] as HTMLElement);
    expect(screen.getByLabelText("Transitive export importer chain")).toHaveTextContent(
      "uses withField (default) → continues as createWebSuite",
    );
    fireEvent.click(screen.getByText("Carried by 1 symbol"));
    fireEvent.click(screen.getByRole("button", { name: /createWebSuite/ }));
    expect(onSelectCarrier).toHaveBeenCalledWith("consumer", "createWebSuite");
    fireEvent.click(
      screen.getByRole("button", { name: "Open importer chain usage /project/src/index.ts" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(screen.getByRole("img", { name: "Complete importer export chain" })).toBeVisible();
    expect(document.querySelectorAll(".reference-graph.is-chain .is-chain-step")).toHaveLength(3);
    const consumerGroups = document.querySelectorAll(
      '.reference-graph.is-chain .graph-file-group.is-multi[data-module-id="consumer"]',
    );
    expect(consumerGroups).toHaveLength(1);
    const consumerNodes = document.querySelectorAll(
      '.reference-graph.is-chain .graph-node[data-module-id="consumer"]',
    );
    expect(consumerNodes).toHaveLength(2);
    expect(consumerNodes[0]).toHaveClass("file-tone-0");
    expect(consumerNodes[1]).toHaveClass("file-tone-0");
    expect(
      document.querySelector('.reference-graph.is-chain .graph-node[data-module-id="upstream"]'),
    ).toHaveClass("file-tone-1");
    const upstreamNode = screen.getByLabelText("Show usage ./src/index.ts");
    expect(upstreamNode).toBeVisible();
    expect(upstreamNode).toHaveAttribute("data-full-path", "/project/src/index.ts");
    expect(upstreamNode.querySelector("title")).toHaveTextContent("/project/src/index.ts");
    fireEvent.click(upstreamNode);
    fireEvent.click(screen.getByRole("button", { name: "Module Graph" }));
    expect(screen.getByRole("button", { name: "Importers: 2 edges" })).toHaveClass("active");
    expect(screen.getByRole("img", { name: "Transitive structural module graph" })).toBeVisible();
    expect(
      document.querySelectorAll(".reference-graph.is-module-graph .is-module-node"),
    ).toHaveLength(2);
    expect(
      document.querySelector(
        '.reference-graph.is-module-graph .is-module-node[data-module-id="upstream"]',
      ),
    ).toHaveAttribute("data-depth", "-2");
    expect(screen.getByRole("status")).toHaveTextContent("2 levels · 3 modules · 2 module edges");
    fireEvent.click(screen.getByRole("button", { name: "Show 2 more levels" }));
    expect(onLoadGraphDepth).toHaveBeenCalledWith(4);
    expect(onSelectEdge.mock.calls).toEqual([
      ["edge-21"],
      ["edge-34"],
      ["upstream-edge"],
      ["upstream-edge"],
    ]);
  });

  it("keeps source available and opens export chains with their module graphs", async () => {
    let resolveStatus: (status: SourceExportAnalysisStatus) => void = () => undefined;
    api.loadSourceExportStatus.mockReturnValueOnce(
      new Promise<SourceExportAnalysisStatus>((resolve) => {
        resolveStatus = resolve;
      }),
    );
    api.loadCoverageSource.mockResolvedValue(detail);
    const usedReferences: ModuleReferencesResponse = {
      module: {
        id: "target",
        identifier: "/project/src/exports.ts",
        name: "./src/exports.ts",
        resource: "/project/src/exports.ts",
        moduleType: "javascript/auto",
        chunks: ["main"],
        issuer: null,
        size: 20,
        usedExports: ["ACTIONS"],
        providedExports: ["ACTIONS", "EVENTS", "NAMESPACE"],
        optimizationBailout: [],
        nested: false,
      },
      direction: "both",
      counts: { in: 3, out: 0, both: 3 },
      total: 3,
      cursor: 0,
      nextCursor: null,
      edges: [
        {
          id: "edge",
          originId: "consumer",
          targetId: "target",
          dependencyType: "esm import",
          request: "./exports",
          exports: ["ACTIONS"],
          active: true,
          location: null,
          origin: {
            id: "consumer",
            identifier: "/project/src/consumer.ts",
            name: "./src/consumer.ts",
            resource: "/project/src/consumer.ts",
            moduleType: "javascript/auto",
            chunks: ["main"],
            issuer: null,
            entry: true,
            size: 20,
            usedExports: true,
            providedExports: null,
            optimizationBailout: [],
            nested: false,
          },
          target: {
            id: "target",
            identifier: "/project/src/exports.ts",
            name: "./src/exports.ts",
            resource: "/project/src/exports.ts",
            moduleType: "javascript/auto",
            chunks: ["main"],
            issuer: null,
            size: 20,
            usedExports: ["ACTIONS"],
            providedExports: ["ACTIONS", "EVENTS", "NAMESPACE"],
            optimizationBailout: [],
            nested: false,
          },
        },
      ],
      entryPath: [],
    };
    const originalEdge = usedReferences.edges[0];
    if (!originalEdge) throw new Error("Expected the used export edge fixture.");
    usedReferences.edges.push({
      ...originalEdge,
      id: "generic-module-edge",
      exports: null,
    });
    usedReferences.edges.push({
      ...originalEdge,
      id: "sibling-export-edge",
      exports: ["EVENTS"],
    });
    const emptyGraph: ModuleReferencesResponse = {
      module: {
        id: "unused-target",
        identifier: "/project/src/exports.ts|unused-instance",
        name: "./src/exports.ts + 1 modules",
        resource: "/project/src/exports.ts",
        moduleType: "javascript/auto",
        chunks: ["async"],
        issuer: null,
        entry: true,
        size: 20,
        usedExports: [],
        providedExports: ["ACTIONS", "EVENTS", "NAMESPACE"],
        optimizationBailout: [],
        nested: false,
      },
      direction: "both",
      counts: { in: 0, out: 0, both: 0 },
      total: 0,
      cursor: 0,
      nextCursor: null,
      edges: [],
      entryPath: [],
    };
    const sourceGraphModule = {
      id: "unused-target-source",
      identifier: "/project/src/exports.ts",
      name: "./src/exports.ts",
      resource: "/project/src/exports.ts",
      moduleType: "javascript/auto",
      chunks: [],
      issuer: null,
      entry: true,
      size: 20,
      usedExports: [],
      providedExports: ["ACTIONS", "EVENTS", "NAMESPACE"],
      optimizationBailout: [],
      nested: false,
    };
    const dependencyModule = {
      id: "dependency",
      identifier: "/project/src/dependency.ts",
      name: "./src/dependency.ts",
      resource: "/project/src/dependency.ts",
      moduleType: "javascript/auto",
      chunks: ["async"],
      issuer: "./src/exports.ts",
      size: 10,
      usedExports: true,
      providedExports: ["default"],
      optimizationBailout: [],
      nested: false,
    };
    const sourceGraph: ModuleReferencesResponse = {
      module: sourceGraphModule,
      direction: "both",
      counts: { in: 0, out: 1, both: 1 },
      total: 1,
      cursor: 0,
      nextCursor: null,
      edges: [
        {
          id: "outgoing-edge",
          originId: sourceGraphModule.id,
          targetId: dependencyModule.id,
          dependencyType: "esm import",
          request: "./dependency",
          exports: ["default"],
          active: true,
          location: null,
          origin: sourceGraphModule,
          target: dependencyModule,
        },
      ],
      entryPath: [sourceGraphModule],
    };
    const forDirection = (
      response: ModuleReferencesResponse,
      direction: "in" | "out" | "both",
    ): ModuleReferencesResponse => ({
      ...response,
      direction,
      total: response.counts[direction],
      edges: response.edges.filter(
        (edge) =>
          direction === "both" ||
          (direction === "in"
            ? edge.targetId === response.module.id
            : edge.originId === response.module.id),
      ),
    });
    api.loadExportImporterChain.mockImplementation((moduleId: string, exportedName: string) => {
      const graph =
        moduleId === "target"
          ? usedReferences
          : moduleId === "unused-target-source"
            ? sourceGraph
            : emptyGraph;
      return Promise.resolve({
        module: graph.module,
        exportedName,
        binding: { exportedName, localName: exportedName },
        steps:
          moduleId === "target"
            ? [
                {
                  id: `chain:${exportedName}`,
                  parentId: null,
                  depth: 1,
                  importedExport: exportedName,
                  importedBinding: { exportedName, localName: exportedName },
                  importerExports: [],
                  importerBindings: [],
                  relationPrecision: "unavailable" as const,
                  edge: originalEdge,
                },
              ]
            : [],
        precision: "source-inferred" as const,
        truncated: false,
        maxDepth: 12,
      });
    });
    api.loadReferences.mockImplementation((moduleId: string, direction: "in" | "out" | "both") => {
      if (moduleId === "target") return Promise.resolve(forDirection(usedReferences, direction));
      if (moduleId === "unused-target-source")
        return Promise.resolve(forDirection(sourceGraph, direction));
      return Promise.resolve(forDirection(emptyGraph, direction));
    });
    api.loadReferenceSnippet.mockResolvedValue({
      edge: originalEdge,
      available: true,
      gap: null,
      code: {
        view: "source",
        sourceId: "src/consumer.ts",
        filename: "src/consumer.ts",
        language: "typescript",
        content: "used();\nunused();",
        spans: [
          { start: 0, end: 7, status: "executed" },
          { start: 8, end: 17, status: "unexecuted" },
        ],
        offset: 0,
        endOffset: 17,
        startLine: 1,
        totalCharacters: 17,
        hasPrevious: false,
        hasNext: false,
        provenance: "coverage-analysis",
        gap: null,
      },
      filename: "src/consumer.ts",
      startLine: 1,
      endLine: 2,
      highlight: { start: 8, end: 14, coverageStatus: "unexecuted" },
      coverage: file.metrics,
      location: {
        start: { line: 2, column: 0 },
        end: { line: 2, column: 6 },
      },
    });
    api.openInEditor.mockResolvedValue({
      opened: true,
      method: "code",
      url: "vscode://file/project/src/exports.ts:1:1",
    });
    const onClose = vi.fn();
    render(<SourceDrawer buildHash="build" file={file} moduleId="target" onClose={onClose} />);

    expect(screen.getByText("Starting")).toBeVisible();
    expect(await screen.findByText("export", { selector: ".syntax-keyword" })).toBeVisible();
    expect(api.loadCoverageSource).toHaveBeenCalledWith(
      "build",
      file.id,
      expect.anything(),
      0,
      "target",
    );
    expect(screen.getByLabelText("Source details for src/exports.ts")).toHaveClass(
      "coverage-source-drawer",
    );
    expect(screen.getByText("Loaded").parentElement).toHaveTextContent("12 B");
    expect(screen.getByText("Executed").parentElement).toHaveTextContent("4 B");
    expect(screen.getByText("Unused").parentElement).toHaveTextContent("8 B");
    const drawerHeader = document.querySelector(".coverage-source-drawer > header");
    expect(drawerHeader).toHaveTextContent("src/exports.ts");
    expect(drawerHeader).not.toHaveTextContent("Original source");
    const sourcePathButton = screen.getByRole("button", {
      name: "Open src/exports.ts in VS Code",
    });
    expect(sourcePathButton).toHaveAttribute("title", "src/exports.ts");
    expect(sourcePathButton).toHaveAttribute("data-full-path", "src/exports.ts");
    fireEvent.click(sourcePathButton);
    expect(api.openInEditor).toHaveBeenCalledWith({
      moduleId: "target",
      sourceId: "src/exports.ts",
      line: 1,
      column: 1,
    });
    expect(document.querySelector(".source-columns")).toHaveTextContent("LineSource");
    expect(document.querySelector(".source-line")?.children).toHaveLength(2);
    expect(document.querySelector(".source-line .coverage-executed")).toHaveTextContent(
      "export { ACTIONS, EVENTS, NAMESPACE };",
    );
    expect(document.querySelector(".source-line .coverage-unexecuted")).toHaveTextContent(
      "const cold = 'unused';",
    );
    expect(document.querySelector(".source-line .syntax-keyword")).toHaveTextContent("export");
    const sourceScroll = document.querySelector(".source-scroll");
    const wrapLines = screen.getByRole("button", { name: "Wrap lines" });
    expect(sourceScroll).not.toHaveClass("is-wrapped");
    expect(wrapLines).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(wrapLines);
    expect(sourceScroll).toHaveClass("is-wrapped");
    expect(wrapLines).toHaveAttribute("aria-pressed", "true");
    const sourceSearch = screen.getByRole("searchbox", { name: "Search source code" });
    fireEvent.change(sourceSearch, { target: { value: "unused" } });
    expect(document.querySelector(".code-search-status")).toHaveTextContent("1 / 1");
    expect(document.querySelector(".code-search-match.is-active")).toHaveTextContent("unused");
    expect(document.querySelector(".source-line.is-search-active")).toHaveTextContent(
      "const cold = 'unused';",
    );
    fireEvent.keyDown(sourceSearch, { key: "Escape" });
    expect(sourceSearch).toHaveValue("");

    fireEvent.click(screen.getByLabelText("Source details for src/exports.ts"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss source details" }));
    expect(onClose).toHaveBeenCalledOnce();

    onClose.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Close source details" }));
    expect(onClose).toHaveBeenCalledOnce();

    await act(async () => resolveStatus(completeStatus()));

    expect(screen.getByText(/3 exports/)).toHaveTextContent("2 used");
    expect(screen.getByRole("button", { name: "ACTIONS" })).toHaveClass(
      "export-marker",
      "state-used",
    );
    expect(screen.getByRole("button", { name: "EVENTS" })).toHaveClass(
      "export-marker",
      "state-unused",
    );
    expect(screen.queryByRole("button", { name: "NAMESPACE" })).toBeNull();
    expect(screen.getByLabelText("Source details for src/exports.ts")).toHaveTextContent(
      "NAMESPACE",
    );
    const sourceExports = screen.getByRole("group", { name: "Current module exports" });
    expect(sourceExports).toHaveTextContent("ExportsACTIONS");
    expect(sourceExports).not.toHaveTextContent("EVENTS");

    fireEvent.click(screen.getByRole("button", { name: "Open module graph for src/exports.ts" }));
    expect(await screen.findByLabelText("Export references and module graph")).toBeVisible();
    expect(screen.getByText("Module investigation")).toBeVisible();
    expect(screen.getByText("Corresponding module graph")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Export Usage" })).toBeNull();
    expect(api.loadReferences).toHaveBeenCalledWith("target", "in");
    expect(new URL(location.href).searchParams.get("module")).toBe("target");
    expect(new URL(location.href).searchParams.has("export")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Back to source code" }));

    fireEvent.click(screen.getByRole("button", { name: "Open export usage for ACTIONS" }));
    expect(await screen.findByRole("button", { name: "Export Usage" })).toHaveClass("active");
    expect(new URL(location.href).searchParams.get("export")).toBe("ACTIONS");
    fireEvent.click(screen.getByRole("button", { name: "Back to source code" }));

    fireEvent.mouseEnter(screen.getByRole("button", { name: "ACTIONS" }));
    expect(document.querySelector(".export-popover")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "ACTIONS" }));
    expect(await screen.findByLabelText("Export references and module graph")).toBeVisible();
    expect(screen.getByLabelText("Export importer chain")).toHaveTextContent("ACTIONS");
    expect(screen.getByLabelText("Export importer chain")).toHaveTextContent("Exact");
    expect(screen.getByLabelText("Export importer chain")).toHaveTextContent("Direct refs1");
    expect(screen.getByRole("button", { name: "Export Usage" })).toHaveClass("active");
    expect(screen.getByText("ACTIONS", { selector: ".graph-export-center" })).toBeVisible();
    expect(await screen.findAllByLabelText("Show usage ./src/consumer.ts")).toHaveLength(1);
    expect(document.querySelectorAll(".graph-node.is-export-edge")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Chain" }));
    expect(
      screen.getByRole("button", { name: "Open importer usage src/consumer.ts" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(document.querySelector(".source-code-panel")).toContainElement(
      document.querySelector(".export-dependency-graph"),
    );
    expect(api.loadReferences).toHaveBeenCalledWith("target", "in");
    expect(api.loadExportImporterChain).toHaveBeenCalledWith("target", "ACTIONS");

    const usageNodes = await screen.findAllByLabelText("Show usage ./src/consumer.ts");
    const usageNode = usageNodes[0];
    if (!usageNode) throw new Error("Expected a reference graph node.");
    fireEvent.click(usageNode);
    expect(await screen.findByLabelText("source code coverage")).toHaveTextContent("used();");
    expect(screen.getByLabelText("source code coverage")).toHaveTextContent("unused();");
    expect(
      document.querySelector(".reference-coverage-detail .coverage-code .coverage-executed"),
    ).toHaveTextContent("used();");
    expect(
      document.querySelector(".reference-coverage-detail .coverage-code .coverage-unexecuted"),
    ).toHaveTextContent("unused();");
    expect(
      Array.from(
        document.querySelectorAll(".reference-coverage-detail .usage-highlight"),
        (element) => element.textContent,
      ).join(""),
    ).toBe("unused");
    const usageSearch = screen.getByRole("searchbox", {
      name: "Search usage source code",
    });
    fireEvent.change(usageSearch, { target: { value: "used" } });
    expect(
      document.querySelector(".reference-coverage-detail .code-search-status"),
    ).toHaveTextContent("1 / 2");
    expect(document.querySelectorAll(".reference-coverage-detail .code-search-match")).toHaveLength(
      2,
    );
    expect(
      document.querySelector(".reference-coverage-detail .code-search-match.is-active"),
    ).toHaveTextContent("used");
    fireEvent.click(screen.getByRole("button", { name: "Next usage search match" }));
    expect(
      document.querySelector(".reference-coverage-detail .code-search-status"),
    ).toHaveTextContent("2 / 2");
    expect(
      Array.from(
        document.querySelectorAll(".reference-coverage-detail .usage-highlight"),
        (element) => element.textContent,
      ).join(""),
    ).toBe("unused");
    fireEvent.keyDown(usageSearch, { key: "Escape" });
    expect(usageSearch).toHaveValue("");
    const referenceWorkspace = document.querySelector(".reference-workspace");
    expect(referenceWorkspace).toHaveClass("has-snippet");
    expect(referenceWorkspace?.firstElementChild).toHaveClass("reference-navigation");
    expect(referenceWorkspace?.lastElementChild).toHaveClass(
      "reference-snippet",
      "reference-coverage-detail",
    );

    fireEvent.click(screen.getByRole("button", { name: "Close usage location" }));
    expect(referenceWorkspace).not.toHaveClass("has-snippet");
    expect(document.querySelector(".reference-snippet")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Module Graph" }));
    expect(screen.getByText("Corresponding module graph")).toBeVisible();
    expect(screen.getByRole("button", { name: "Importers: 3 edges" })).toHaveClass("active");
    expect(screen.getByRole("button", { name: "All: 3 edges" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Dependencies: 0 edges" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "All: 3 edges" }));
    expect(await screen.findAllByLabelText("Show usage ./src/consumer.ts")).toHaveLength(3);
    expect(api.loadReferences).toHaveBeenCalledWith("target", "both");

    fireEvent.click(screen.getByRole("button", { name: "Dependencies: 0 edges" }));
    expect(await screen.findByText("No dependency edges captured")).toBeVisible();
    expect(api.loadReferences).toHaveBeenCalledWith("target", "out");

    fireEvent.click(screen.getByRole("button", { name: "Back to source code" }));
    expect(document.querySelector(".export-dependency-graph")).toBeNull();
    expect(new URL(location.href).searchParams.has("module")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "EVENTS" }));
    fireEvent.click(await screen.findByRole("button", { name: "Chain" }));
    expect(await screen.findByText(/No importer uses this export in the selected/)).toBeVisible();
    expect(screen.getByLabelText("Export importer chain")).toHaveTextContent(
      "No importer uses this export",
    );
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(screen.getByText("EVENTS", { selector: ".graph-export-center" })).toBeVisible();
    expect(api.loadReferences).toHaveBeenCalledWith("unused-target", "in");

    fireEvent.click(screen.getByRole("button", { name: "Module Graph" }));
    const graphPicker = screen.getByLabelText("Module graph");
    expect(graphPicker).toHaveTextContent("Chunk graph async");
    expect(graphPicker).toHaveTextContent("Unchunked graph");
    fireEvent.change(graphPicker, { target: { value: "unused-target-source" } });
    expect(await screen.findByText("No importer uses this export")).toBeVisible();
    expect(api.loadReferences).toHaveBeenCalledWith("unused-target-source", "in");
    expect(screen.getByRole("button", { name: "Importers: 0 edges" })).toHaveClass("active");
    expect(screen.getByRole("button", { name: "All: 1 edge" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Dependencies: 1 edge" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Dependencies: 1 edge" }));
    expect(await screen.findByLabelText("Show usage ./src/dependency.ts")).toBeVisible();
    expect(api.loadReferences).toHaveBeenCalledWith("unused-target-source", "out");

    const outgoingLine = document.querySelector(".graph-node .graph-edge");
    expect(outgoingLine).toHaveAttribute("x1", "350");
    expect(outgoingLine).toHaveAttribute("y1", "164");
    expect(outgoingLine).toHaveAttribute("x2", "372");
    expect(outgoingLine).toHaveAttribute("y2", "40");

    fireEvent.click(screen.getByRole("button", { name: "Importers: 0 edges" }));
    expect(await screen.findByText("No importer uses this export")).toBeVisible();
    expect(api.loadReferences).toHaveBeenCalledWith("unused-target-source", "in");

    fireEvent.click(screen.getByRole("button", { name: "Dependencies: 1 edge" }));
    expect(await screen.findByLabelText("Show usage ./src/dependency.ts")).toBeVisible();
    expect(api.loadReferences).toHaveBeenCalledWith("unused-target-source", "out");
  });

  it("uses a compact picker when the current module has many exports", async () => {
    const status = completeStatus();
    if (status.status !== "complete") throw new Error("Expected a complete export fixture.");
    const template = status.report.exports[0];
    if (!template) throw new Error("Expected an export fixture.");
    status.report.exports = Array.from({ length: 5 }, (_, index) => ({
      ...template,
      id: `TOOL_${index}:1:${index}`,
      exportedName: `TOOL_${index}`,
      localName: `TOOL_${index}`,
      range: {
        start: { line: 1, column: index },
        end: { line: 1, column: index + 1 },
      },
    }));
    status.report.summary = { total: 5, used: 5, unused: 0, unknown: 0, typeOnly: 0 };
    const targetModule = {
      id: "target",
      identifier: "/project/src/exports.ts",
      name: "./src/exports.ts",
      resource: "/project/src/exports.ts",
      moduleType: "javascript/auto",
      chunks: ["main"],
      issuer: null,
      entry: true,
      size: 20,
      usedExports: true,
      providedExports: status.report.exports.map((usage) => usage.exportedName),
      optimizationBailout: [],
      nested: false,
    };
    const references: ModuleReferencesResponse = {
      module: targetModule,
      direction: "in",
      counts: { in: 0, out: 0, both: 0 },
      total: 0,
      cursor: 0,
      nextCursor: null,
      edges: [],
      entryPath: [targetModule],
    };
    api.loadCoverageSource.mockResolvedValue(detail);
    api.loadSourceExportStatus.mockResolvedValue(status);
    api.loadReferences.mockResolvedValue(references);
    api.loadExportImporterChain.mockImplementation((_moduleId: string, exportedName: string) =>
      Promise.resolve({
        module: targetModule,
        exportedName,
        binding: { exportedName, localName: exportedName },
        steps: [],
        precision: "native" as const,
        truncated: false,
        maxDepth: 12,
      }),
    );

    render(<SourceDrawer buildHash="build" file={file} moduleId="target" onClose={vi.fn()} />);

    const picker = await screen.findByRole("combobox", { name: "Current module export" });
    expect(screen.queryByRole("group", { name: "Current module exports" })).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(6);
    expect(screen.getByRole("option", { name: "TOOL_4 · used" })).toBeVisible();

    fireEvent.change(picker, { target: { value: "TOOL_4:1:4" } });
    expect(await screen.findByRole("button", { name: "Export Usage" })).toHaveClass("active");
    expect(api.loadExportImporterChain).toHaveBeenCalledWith("target", "TOOL_4");
    expect(new URL(location.href).searchParams.get("export")).toBe("TOOL_4");
    fireEvent.click(screen.getByRole("button", { name: "Back to source code" }));
  });

  it("falls back to paged generated output for an unmapped runtime file", async () => {
    const runtimeFile: SourceFileSummary = {
      ...file,
      id: "[rspack runtime / unmapped]/static/js/main.js",
      path: "[rspack runtime / unmapped]/static/js/main.js",
      displayPath: "[rspack runtime / unmapped]/static/js/main.js",
      category: "runtime",
      moduleIds: [],
      metrics: {
        ...file.metrics,
        mappedBytes: 0,
        unmappedBytes: 20,
      },
    };
    api.loadGeneratedSource.mockImplementation(
      (_buildHash: string, sourceId: string, offset: number) =>
        Promise.resolve({
          view: "output",
          sourceId,
          filename: "static/js/main.js",
          language: "javascript",
          content: "runtime();mapped();",
          spans: [{ start: 0, end: 10, status: "executed" }],
          offset,
          endOffset: offset + 19,
          startLine: 1,
          totalCharacters: 300_000,
          hasPrevious: offset > 0,
          hasNext: offset + 19 < 300_000,
          provenance: "final generated asset / unmapped fallback",
          gap: "Only unmapped bytes are colored; mapped source bytes remain neutral context.",
        }),
    );

    render(<SourceDrawer buildHash="build" file={runtimeFile} moduleId={null} onClose={vi.fn()} />);

    expect(await screen.findByText("Generated output fallback")).toBeVisible();
    expect(screen.queryByText("Export analysis")).toBeNull();
    expect(api.loadCoverageSource).not.toHaveBeenCalled();
    expect(api.loadSourceExportStatus).not.toHaveBeenCalled();
    const generated = await screen.findByLabelText("output code coverage");
    expect(generated.querySelector(".coverage-executed")).toHaveTextContent("runtime();");
    expect(generated.querySelector(".coverage-neutral")).toHaveTextContent("mapped();");
    expect(screen.getByText(/Only unmapped bytes are colored/)).toBeVisible();
    expect(screen.getByText("static/js/main.js")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Next generated code page" }));
    await waitFor(() => {
      expect(api.loadGeneratedSource).toHaveBeenLastCalledWith(
        "build",
        runtimeFile.id,
        19,
        240_000,
        expect.anything(),
        0,
      );
    });
  });
});

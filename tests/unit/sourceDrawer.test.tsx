// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ModuleReferencesResponse,
  SourceExportAnalysisStatus,
  SourceFileDetail,
  SourceFileSummary,
} from "../../src/shared/types.js";
import { SourceDrawer } from "../../src/ui/components/SourceDrawer.js";

const api = vi.hoisted(() => ({
  loadCoverageSource: vi.fn(),
  loadReferenceSnippet: vi.fn(),
  loadReferences: vi.fn(),
  loadSourceExportStatus: vi.fn(),
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
  api.loadReferenceSnippet.mockReset();
  api.loadReferences.mockReset();
  api.loadSourceExportStatus.mockReset();
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
    expect(drawerHeader).toHaveTextContent("exports.ts");
    expect(drawerHeader).not.toHaveTextContent("Original source");
    expect(drawerHeader).not.toHaveTextContent("src/exports.ts");
    expect(document.querySelector(".source-columns")).toHaveTextContent("LineSource");
    expect(document.querySelector(".source-line")?.children).toHaveLength(2);
    expect(document.querySelector(".source-line .coverage-executed")).toHaveTextContent(
      "export { ACTIONS, EVENTS, NAMESPACE };",
    );
    expect(document.querySelector(".source-line .coverage-unexecuted")).toHaveTextContent(
      "const cold = 'unused';",
    );
    expect(document.querySelector(".source-line .syntax-keyword")).toHaveTextContent("export");
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

    fireEvent.mouseEnter(screen.getByRole("button", { name: "ACTIONS" }));
    expect(document.querySelector(".export-popover")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "ACTIONS" }));
    expect(await screen.findByLabelText("Export references and module graph")).toBeVisible();
    expect(screen.getByLabelText("Export importer chain")).toHaveTextContent("ACTIONS");
    expect(screen.getByLabelText("Export importer chain")).toHaveTextContent("Exact");
    expect(screen.getByLabelText("Export importer chain")).toHaveTextContent("Direct refs1");
    expect(
      screen.getByRole("button", { name: "Open importer usage src/consumer.ts" }),
    ).toBeVisible();
    expect(screen.getByText("Corresponding module graph")).toBeVisible();
    expect(document.querySelector(".source-code-panel")).toContainElement(
      document.querySelector(".export-dependency-graph"),
    );
    expect(api.loadReferences).toHaveBeenCalledWith("target", "in");
    expect(screen.getByText("ACTIONS", { selector: ".graph-export-center" })).toBeVisible();
    expect(await screen.findAllByLabelText("Show usage ./src/consumer.ts")).toHaveLength(1);
    expect(document.querySelectorAll(".graph-node.is-export-edge")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Importers: 1 edge" })).toHaveClass("active");
    expect(screen.getByRole("button", { name: "All: 3 edges" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Dependencies: 0 edges" })).toBeVisible();

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
    expect(document.querySelector(".reference-coverage-detail .usage-highlight")).toHaveTextContent(
      "unused",
    );

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
    expect(await screen.findByText("No importer uses this export")).toBeVisible();
    expect(screen.getByLabelText("Export importer chain")).toHaveTextContent(
      "No importer uses this export",
    );
    expect(screen.getByText("EVENTS", { selector: ".graph-export-center" })).toBeVisible();
    expect(api.loadReferences).toHaveBeenCalledWith("unused-target", "in");

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
});

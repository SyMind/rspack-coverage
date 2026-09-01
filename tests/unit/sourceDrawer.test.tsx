// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
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
          references: [
            {
              moduleId: "consumer",
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
          moduleInstances: [],
          referenceCount: 0,
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
          references: [],
          truncated: false,
        },
      ],
    },
  };
}

describe("SourceDrawer export usage", () => {
  it("keeps source available while loading and highlights only exact used exports", async () => {
    let resolveStatus: (status: SourceExportAnalysisStatus) => void = () => undefined;
    api.loadSourceExportStatus.mockReturnValueOnce(
      new Promise<SourceExportAnalysisStatus>((resolve) => {
        resolveStatus = resolve;
      }),
    );
    api.loadCoverageSource.mockResolvedValue(detail);
    api.loadReferences.mockResolvedValue({
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
      direction: "in",
      total: 1,
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
    });
    const onClose = vi.fn();
    render(<SourceDrawer buildHash="build" file={file} onClose={onClose} />);

    expect(screen.getByText("Starting")).toBeVisible();
    expect(await screen.findByText("export", { selector: ".syntax-keyword" })).toBeVisible();
    expect(screen.getByLabelText("Source details for src/exports.ts")).toHaveClass(
      "coverage-source-drawer",
    );
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
    expect(screen.queryByRole("button", { name: "EVENTS" })).toBeNull();
    expect(screen.queryByRole("button", { name: "NAMESPACE" })).toBeNull();
    expect(screen.getByLabelText("Source details for src/exports.ts")).toHaveTextContent(
      "EVENTS, NAMESPACE",
    );

    fireEvent.mouseEnter(screen.getByRole("button", { name: "ACTIONS" }));
    expect(document.querySelector(".export-popover")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "ACTIONS" }));
    expect(await screen.findByText("Module reference chain")).toBeVisible();
    expect(document.querySelector(".source-code-panel")).toContainElement(
      document.querySelector(".export-dependency-graph"),
    );
    expect(api.loadReferences).toHaveBeenCalledWith("target", "in");
    expect(screen.getByText("ACTIONS", { selector: ".graph-export" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Back to source code" }));
    expect(document.querySelector(".export-dependency-graph")).toBeNull();
    expect(new URL(location.href).searchParams.has("module")).toBe(false);
  });
});

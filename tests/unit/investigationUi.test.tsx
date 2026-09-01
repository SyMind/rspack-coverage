// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BuildModule,
  CodeViewResponse,
  ModuleInvestigationDetail,
  SourceFileReport,
  UsageMetrics,
} from "../../src/shared/types.js";
import { CoverageCode } from "../../src/ui/components/CoverageCode.js";
import { SourceDrawer } from "../../src/ui/components/SourceDrawer.js";

const api = vi.hoisted(() => ({
  loadAiContext: vi.fn(),
  loadCode: vi.fn(),
  loadModule: vi.fn(),
  loadReferenceSnippet: vi.fn(),
  loadReferences: vi.fn(),
  loadSource: vi.fn(),
  openInEditor: vi.fn(),
}));

vi.mock("../../src/ui/lib/api.js", () => api);

function metrics(): UsageMetrics {
  return {
    emittedBytes: 0,
    loadedBytes: 0,
    executedBytes: 0,
    unusedBytes: 0,
    notLoadedBytes: 0,
    mappedBytes: 0,
    unmappedBytes: 0,
    usageRatio: null,
  };
}

const module: BuildModule = {
  id: "module",
  identifier: "/project/src/module.js?variant",
  readableIdentifier: "./src/module.js",
  name: "./src/module.js",
  resource: "/project/src/module.js",
  chunks: ["main"],
  issuer: null,
  size: 20,
  usedExports: true,
  providedExports: ["value"],
  nested: false,
};

const file: SourceFileReport = {
  id: "src/module.js",
  path: "src/module.js",
  displayPath: "src/module.js",
  category: "first-party",
  metrics: metrics(),
  chunks: ["main"],
  loadedChunks: [],
  moduleIds: ["module"],
  duplicated: false,
  content: null,
  lines: [],
};

afterEach(cleanup);

beforeEach(() => {
  history.replaceState(null, "", "/__rspack_coverage__/");
  api.loadModule.mockReset();
  api.loadCode.mockReset();
  api.loadReferences.mockReset();
  api.loadSource.mockReset();
  api.loadModule.mockResolvedValue({
    ...module,
    sources: [
      {
        id: file.id,
        name: file.path,
        mappedBytes: 0,
        loadedBytes: 0,
        executedBytes: 0,
      },
    ],
    metrics: metrics(),
    incomingReferences: 0,
    outgoingReferences: 0,
    views: {
      source: true,
      output: true,
      finalAsset: false,
      codeGeneration: true,
      hasMappedOutput: false,
      preferred: "output",
      outputKind: "module-code-generation",
    },
  } satisfies ModuleInvestigationDetail);
  api.loadCode.mockResolvedValue({
    view: "output",
    sourceId: null,
    filename: "module.js · code generation",
    language: "javascript",
    content: "const value = 1;",
    spans: [{ start: 0, end: 16, status: "unknown" }],
    offset: 0,
    endOffset: 16,
    startLine: 1,
    totalCharacters: 16,
    hasPrevious: false,
    hasNext: false,
    provenance: "module-code-generation",
    gap: "Mapped generated characters are 0.",
  } satisfies CodeViewResponse);
  api.loadReferences.mockResolvedValue({
    module,
    direction: "both",
    total: 0,
    cursor: 0,
    nextCursor: null,
    edges: [],
    entryPath: [],
  });
});

describe("coverage investigation UI", () => {
  it("renders executed code green and loaded-but-unexecuted code red", () => {
    render(
      <CoverageCode
        code={{
          view: "source",
          sourceId: "source",
          filename: "source.js",
          language: "javascript",
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
          provenance: "test",
          gap: null,
        }}
      />,
    );

    expect(document.querySelector(".coverage-executed")).toHaveTextContent("used();");
    expect(document.querySelector(".coverage-unexecuted")).toHaveTextContent("unused();");
  });

  it("automatically falls back to code generation when mapped characters are zero", async () => {
    render(<SourceDrawer file={file} modules={[module]} onClose={vi.fn()} />);

    await waitFor(() => expect(api.loadCode).toHaveBeenCalled());
    expect(api.loadCode).toHaveBeenCalledWith(
      "module",
      expect.objectContaining({ view: "output", sourceId: file.id }),
    );
    expect(screen.getByRole("button", { name: "Final output" })).toHaveClass("active");
    expect(screen.getByText("Mapped generated characters are 0.")).toBeInTheDocument();
    expect(document.querySelector(".coverage-code")).toHaveTextContent("const value = 1;");
  });

  it("colors source-map-only files from their source line evidence", async () => {
    const sourceMapOnly: SourceFileReport = {
      ...file,
      id: "webpack/runtime/example",
      path: "webpack/runtime/example",
      displayPath: "webpack/runtime/example",
      category: "runtime",
      moduleIds: [],
    };
    api.loadSource.mockResolvedValue({
      ...sourceMapOnly,
      content: "used();\nunused();",
      lines: [
        {
          line: 1,
          text: "used();",
          buildState: "retained",
          runtimeState: "executed",
          emittedBytes: 7,
          executedBytes: 7,
          chunks: ["main"],
          ranges: [],
        },
        {
          line: 2,
          text: "unused();",
          buildState: "retained",
          runtimeState: "not-executed",
          emittedBytes: 9,
          executedBytes: 0,
          chunks: ["main"],
          ranges: [],
        },
      ],
    } satisfies SourceFileReport);

    render(<SourceDrawer file={sourceMapOnly} modules={[]} onClose={vi.fn()} />);

    await waitFor(() => expect(api.loadSource).toHaveBeenCalledWith(sourceMapOnly.id));
    expect(document.querySelector(".coverage-executed")).toHaveTextContent("used();");
    expect(document.querySelector(".coverage-unexecuted")).toHaveTextContent("unused();");
  });
});

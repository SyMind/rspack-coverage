// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceFileSummary, TreeNodeReport, UsageMetrics } from "../../src/shared/types.js";
import { SourceExplorer, sortModuleSources } from "../../src/ui/components/SourceExplorer.js";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 38,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        size: 38,
        start: index * 38,
      })),
  }),
}));

afterEach(cleanup);

function metrics(unusedBytes: number, loadedBytes = unusedBytes + 100): UsageMetrics {
  return {
    emittedBytes: loadedBytes,
    loadedBytes,
    executedBytes: loadedBytes - unusedBytes,
    unusedBytes,
    notLoadedBytes: 0,
    mappedBytes: loadedBytes,
    unmappedBytes: 0,
    usageRatio: loadedBytes ? (loadedBytes - unusedBytes) / loadedBytes : null,
  };
}

function source(
  path: string,
  unusedBytes: number,
  category: SourceFileSummary["category"] = "first-party",
  duplicated = false,
): SourceFileSummary {
  return {
    id: path,
    path,
    displayPath: path,
    category,
    metrics: metrics(unusedBytes),
    chunks: duplicated ? ["main", "lazy"] : ["main"],
    loadedChunks: duplicated ? ["main", "lazy"] : ["main"],
    moduleIds: [],
    duplicated,
  };
}

function fileNode(file: SourceFileSummary): TreeNodeReport {
  return {
    id: `file:${file.id}`,
    name: file.path.split("/").at(-1) ?? file.path,
    path: file.path,
    kind: "file",
    category: file.category,
    metrics: file.metrics,
    chunks: file.chunks,
    duplicated: file.duplicated,
    fileId: file.id,
    children: [],
  };
}

function fixture() {
  const files = [
    source("src/zeta.js", 200),
    source("node_modules/pkg/index.js", 100, "node_modules"),
    source("src/heavy.js", 800, "first-party", true),
    source("src/alpha.js", 200),
  ];
  const srcFiles = files.filter((file) => file.category === "first-party");
  const dependency = files.find((file) => file.category === "node_modules");
  if (!dependency) throw new Error("Missing dependency fixture");
  const tree: TreeNodeReport = {
    id: "root",
    name: "Sources",
    path: "",
    kind: "root",
    category: "all",
    metrics: metrics(1_300),
    chunks: ["main", "lazy"],
    duplicated: true,
    children: [
      {
        id: "dir:src",
        name: "src",
        path: "src",
        kind: "directory",
        category: "first-party",
        metrics: metrics(1_200),
        chunks: ["main", "lazy"],
        duplicated: true,
        children: srcFiles.map(fileNode),
      },
      {
        id: "dir:node_modules",
        name: "node_modules",
        path: "node_modules",
        kind: "directory",
        category: "node_modules",
        metrics: metrics(100),
        chunks: ["main"],
        duplicated: false,
        children: [fileNode(dependency)],
      },
    ],
  };
  return { files, tree };
}

describe("SourceExplorer", () => {
  it("defaults to Modules and orders source-map sources by unused bytes then path", () => {
    const { files, tree } = fixture();
    const onSelectFile = vi.fn();
    render(
      <SourceExplorer
        tree={tree}
        files={files}
        selectedFileId={null}
        onSelectFile={onSelectFile}
      />,
    );

    expect(screen.getByRole("button", { name: "Modules" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "Modules" })).toBeInTheDocument();
    const sourceRows = screen.getAllByRole("button", { name: /^Open source / });
    expect(sourceRows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Open source src/heavy.js",
      "Open source src/alpha.js",
      "Open source src/zeta.js",
      "Open source node_modules/pkg/index.js",
    ]);
    expect(within(sourceRows[0] as HTMLElement).getByText("duplicated")).toBeInTheDocument();

    fireEvent.click(sourceRows[0] as HTMLElement);
    expect(onSelectFile).toHaveBeenCalledWith(files[2]);
  });

  it("shares filters and supports directory expansion", () => {
    const { files, tree } = fixture();
    render(
      <SourceExplorer tree={tree} files={files} selectedFileId={null} onSelectFile={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText("Search sources"), { target: { value: "alpha" } });
    expect(screen.getByRole("button", { name: "Open source src/alpha.js" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open source src/heavy.js" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Directory" }));
    expect(screen.getByRole("heading", { name: "Directory tree" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse directory src" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open source src/alpha.js" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search sources"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Collapse directory src" }));
    expect(screen.queryByRole("button", { name: "Open source src/heavy.js" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand directory src" }));
    expect(screen.getByRole("button", { name: "Open source src/heavy.js" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Source category"), {
      target: { value: "node_modules" },
    });
    expect(screen.queryByRole("button", { name: /directory src/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Collapse directory node_modules" })).toBeVisible();
  });

  it("sorts large module collections without mutating the report", () => {
    const files = Array.from({ length: 5_000 }, (_, index) =>
      source(`src/module-${String(index).padStart(4, "0")}.js`, index % 101),
    );
    const before = [...files];
    const sorted = sortModuleSources(files);

    expect(files).toEqual(before);
    expect(sorted).toHaveLength(5_000);
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (!previous || !current) throw new Error("Missing sorted source");
      expect(previous.metrics.unusedBytes).toBeGreaterThanOrEqual(current.metrics.unusedBytes);
      if (previous.metrics.unusedBytes === current.metrics.unusedBytes) {
        expect(previous.path.localeCompare(current.path)).toBeLessThanOrEqual(0);
      }
    }
  });
});

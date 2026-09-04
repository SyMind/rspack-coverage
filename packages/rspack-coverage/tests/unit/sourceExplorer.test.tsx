// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BuildModule,
  SourceFileSummary,
  TreeNodeReport,
  UsageMetrics,
} from "../../src/shared/types.js";
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
    moduleIds: [`module:${path}`],
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
    {
      ...source("[rspack runtime / unmapped]/main.js", 900, "runtime"),
      moduleIds: [],
    },
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
        selectedModuleId={null}
        onSelectFile={onSelectFile}
      />,
    );

    expect(screen.getByRole("button", { name: "Modules" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "Modules" })).toBeInTheDocument();
    const sourceRows = screen.getAllByRole("button", { name: /^Open module / });
    expect(sourceRows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Open module src/heavy.js",
      "Open module src/alpha.js",
      "Open module src/zeta.js",
      "Open module node_modules/pkg/index.js",
    ]);
    expect(within(sourceRows[0] as HTMLElement).getByText("duplicated")).toBeInTheDocument();
    expect(within(sourceRows[0] as HTMLElement).getByText("src/heavy.js")).toHaveAttribute(
      "data-full-path",
      "src/heavy.js",
    );

    fireEvent.click(sourceRows[0] as HTMLElement);
    expect(onSelectFile).toHaveBeenCalledWith(files[2], "module:src/heavy.js");
  });

  it("shares filters and supports directory expansion", () => {
    const { files, tree } = fixture();
    render(
      <SourceExplorer
        tree={tree}
        files={files}
        selectedFileId={null}
        selectedModuleId={null}
        onSelectFile={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Search sources"), { target: { value: "alpha" } });
    expect(screen.getByRole("button", { name: "Open module src/alpha.js" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open module src/heavy.js" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Directory" }));
    expect(screen.getByRole("heading", { name: "Directory tree" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse directory src" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open source src/alpha.js" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Search sources"), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Expand directory src" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open source src/heavy.js" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand directory src" }));
    expect(screen.getByRole("button", { name: "Open source src/heavy.js" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Source category"), {
      target: { value: "node_modules" },
    });
    expect(screen.queryByRole("button", { name: /directory src/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Expand directory node_modules" })).toBeVisible();
  });

  it("filters modules and directory descendants to usage above zero", () => {
    const positive = source("src/positive.js", 50);
    const zero = {
      ...source("src/zero.js", 100),
      metrics: metrics(100, 100),
    };
    const tree: TreeNodeReport = {
      id: "root",
      name: "Sources",
      path: "",
      kind: "root",
      category: "all",
      metrics: metrics(150, 250),
      chunks: ["main"],
      duplicated: false,
      children: [
        {
          id: "dir:src",
          name: "src",
          path: "src",
          kind: "directory",
          category: "first-party",
          metrics: metrics(150, 250),
          chunks: ["main"],
          duplicated: false,
          children: [fileNode(positive), fileNode(zero)],
        },
      ],
    };
    render(
      <SourceExplorer
        tree={tree}
        files={[positive, zero]}
        selectedFileId={null}
        selectedModuleId={null}
        onSelectFile={vi.fn()}
      />,
    );

    const toggle = screen.getByRole("button", { name: "Usage > 0%" });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Open module src/positive.js" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open module src/zero.js" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Directory" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand directory src" }));
    expect(screen.getByRole("button", { name: "Open source src/positive.js" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open source src/zero.js" })).toBeNull();
  });

  it("defaults the directory tree to collapsed and sorts siblings by aggregated columns", () => {
    const { files, tree } = fixture();
    render(
      <SourceExplorer
        tree={tree}
        files={files}
        selectedFileId={null}
        selectedModuleId={null}
        onSelectFile={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Directory" }));
    const directoryPaths = () =>
      screen
        .getAllByRole("button", { name: /^(?:Expand|Collapse) directory / })
        .map((row) =>
          row.getAttribute("aria-label")?.replace(/^(?:Expand|Collapse) directory /, ""),
        );

    expect(directoryPaths()).toEqual(["src", "node_modules"]);
    expect(screen.queryByRole("button", { name: /^Open source / })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Sort directory tree by Unexecuted, descending" }),
    ).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Sort directory tree by Path" }));
    expect(directoryPaths()).toEqual(["node_modules", "src"]);
    fireEvent.click(screen.getByRole("button", { name: "Sort directory tree by Loaded" }));
    expect(directoryPaths()).toEqual(["src", "node_modules"]);
    fireEvent.click(screen.getByRole("button", { name: "Sort directory tree by Usage" }));
    expect(directoryPaths()).toEqual(["node_modules", "src"]);
    fireEvent.click(
      screen.getByRole("button", { name: "Sort directory tree by Usage, descending" }),
    );
    expect(directoryPaths()).toEqual(["src", "node_modules"]);
    fireEvent.click(screen.getByRole("button", { name: "Sort directory tree by Chunks" }));
    expect(directoryPaths()).toEqual(["src", "node_modules"]);

    fireEvent.click(screen.getByRole("button", { name: "Expand directory src" }));
    expect(
      screen
        .getAllByRole("button", { name: /^Open source / })
        .map((row) => row.getAttribute("aria-label")?.replace("Open source ", "")),
    ).toEqual(["src/heavy.js", "src/alpha.js", "src/zeta.js"]);
  });

  it("sorts module rows from each column header and toggles direction", () => {
    const { files, tree } = fixture();
    render(
      <SourceExplorer
        tree={tree}
        files={files}
        selectedFileId={null}
        selectedModuleId={null}
        onSelectFile={vi.fn()}
      />,
    );

    const rowPaths = () =>
      screen
        .getAllByRole("button", { name: /^Open module / })
        .map((row) => row.getAttribute("aria-label")?.replace("Open module ", ""));

    const loaded = screen.getByRole("button", { name: /Sort modules by Loaded/ });
    fireEvent.click(loaded);
    expect(rowPaths()).toEqual([
      "src/heavy.js",
      "src/alpha.js",
      "src/zeta.js",
      "node_modules/pkg/index.js",
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Sort modules by Loaded/ }));
    expect(rowPaths()).toEqual([
      "node_modules/pkg/index.js",
      "src/alpha.js",
      "src/zeta.js",
      "src/heavy.js",
    ]);

    fireEvent.click(screen.getByRole("button", { name: /Sort modules by Usage/ }));
    expect(rowPaths()).toEqual([
      "node_modules/pkg/index.js",
      "src/alpha.js",
      "src/zeta.js",
      "src/heavy.js",
    ]);

    fireEvent.click(screen.getByRole("button", { name: /Sort modules by Chunks/ }));
    expect(rowPaths()).toEqual([
      "src/heavy.js",
      "node_modules/pkg/index.js",
      "src/alpha.js",
      "src/zeta.js",
    ]);

    fireEvent.click(screen.getByRole("button", { name: /Sort modules by Path/ }));
    expect(rowPaths()).toEqual([
      "node_modules/pkg/index.js",
      "src/alpha.js",
      "src/heavy.js",
      "src/zeta.js",
    ]);
    expect(screen.getByRole("button", { name: /Sort modules by Path, ascending/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("keeps separate Rspack module identities for one mapped source", () => {
    const file = {
      ...source("src/shared.ts", 100),
      moduleIds: ["module-a", "module-b"],
      moduleMetrics: metrics(7, 20),
    };
    const tree: TreeNodeReport = {
      id: "root",
      name: "Sources",
      path: "",
      kind: "root",
      category: "all",
      metrics: file.metrics,
      chunks: file.chunks,
      duplicated: false,
      children: [fileNode(file)],
    };
    const onSelectFile = vi.fn();
    const modules: BuildModule[] = [
      {
        id: "module-a",
        identifier: "javascript/auto|/project/src/shared.ts",
        readableIdentifier: "./src/shared.ts",
        name: "./src/shared.ts",
        resource: "/project/src/shared.ts",
        moduleType: "javascript/auto",
        chunks: ["main"],
        issuer: null,
        size: 20,
        usedExports: true,
        providedExports: null,
        optimizationBailout: [],
        nested: false,
      },
      {
        id: "module-b",
        identifier: "javascript/auto|/project/src/shared.ts?lazy",
        readableIdentifier: "./src/shared.ts?lazy",
        name: "./src/shared.ts?lazy",
        resource: "/project/src/shared.ts",
        moduleType: "javascript/auto",
        chunks: ["lazy"],
        issuer: null,
        size: 20,
        usedExports: true,
        providedExports: null,
        optimizationBailout: [],
        nested: false,
      },
    ];
    render(
      <SourceExplorer
        tree={tree}
        files={[file]}
        modules={modules}
        selectedFileId={null}
        selectedModuleId={null}
        onSelectFile={onSelectFile}
      />,
    );

    const primaryRow = screen.getByRole("button", { name: "Open module ./src/shared.ts" });
    const lazyRow = screen.getByRole("button", { name: "Open module ./src/shared.ts?lazy" });
    expect(primaryRow).toHaveTextContent("20 B7 B65%");
    expect(lazyRow).toHaveTextContent("0 B0 B—");
    expect(within(primaryRow).getByText("./src/shared.ts")).toHaveAttribute(
      "title",
      "/project/src/shared.ts",
    );
    expect(within(primaryRow).getByText("./src/shared.ts")).toHaveAttribute(
      "data-full-path",
      "/project/src/shared.ts",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Search sources" }), {
      target: { value: "shared.ts?lazy" },
    });
    expect(screen.queryByRole("button", { name: "Open module ./src/shared.ts" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open module ./src/shared.ts?lazy" }));
    expect(onSelectFile).toHaveBeenCalledWith(file, "module-b");
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

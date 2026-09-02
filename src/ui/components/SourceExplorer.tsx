import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import { metricsForModuleInstance } from "../../shared/metrics.js";
import type { BuildModule, SourceFileSummary, TreeNodeReport } from "../../shared/types.js";
import { formatBytes, formatPercent, usageColor } from "../lib/format.js";

type SourceView = "modules" | "directory";
type FlatNode = { node: TreeNodeReport; depth: number; moduleId: string | null };
type ModuleSortKey = "path" | "loaded" | "unused" | "usage" | "chunks";
type SortDirection = "asc" | "desc";
type ModuleSort = { key: ModuleSortKey; direction: SortDirection };

const DEFAULT_MODULE_SORT: ModuleSort = { key: "unused", direction: "desc" };

function displayedModuleMetrics(
  file: SourceFileSummary,
  module?: BuildModule,
): SourceFileSummary["metrics"] {
  return metricsForModuleInstance(file, module);
}

function compareByUnusedBytesAndPath(
  left: Pick<SourceFileSummary, "path" | "metrics">,
  right: Pick<SourceFileSummary, "path" | "metrics">,
): number {
  return (
    right.metrics.unusedBytes - left.metrics.unusedBytes || left.path.localeCompare(right.path)
  );
}

function compareModuleRows(left: FlatNode, right: FlatNode, sort: ModuleSort): number {
  let compared = 0;
  switch (sort.key) {
    case "path":
      compared = left.node.path.localeCompare(right.node.path);
      break;
    case "loaded":
      compared = left.node.metrics.loadedBytes - right.node.metrics.loadedBytes;
      break;
    case "unused":
      compared = left.node.metrics.unusedBytes - right.node.metrics.unusedBytes;
      break;
    case "usage": {
      const leftUsage = left.node.metrics.usageRatio;
      const rightUsage = right.node.metrics.usageRatio;
      if (leftUsage === null || rightUsage === null) {
        if (leftUsage !== rightUsage) return leftUsage === null ? 1 : -1;
      } else {
        compared = leftUsage - rightUsage;
      }
      break;
    }
    case "chunks":
      compared = left.node.chunks.length - right.node.chunks.length;
      break;
  }
  if (compared !== 0) return sort.direction === "asc" ? compared : -compared;
  return (
    left.node.path.localeCompare(right.node.path) ||
    (left.moduleId ?? "").localeCompare(right.moduleId ?? "")
  );
}

export function sortModuleSources(files: SourceFileSummary[]): SourceFileSummary[] {
  return files
    .filter((file) => file.moduleIds.length > 0)
    .sort((left, right) =>
      compareByUnusedBytesAndPath(
        { path: left.path, metrics: displayedModuleMetrics(left) },
        { path: right.path, metrics: displayedModuleMetrics(right) },
      ),
    );
}

function matchesFilter(node: TreeNodeReport, category: string, search: string): boolean {
  const categoryMatches =
    category === "all" || node.category === category || node.category === "mixed";
  const searchMatches = !search || node.path.toLowerCase().includes(search);
  return (
    categoryMatches &&
    (searchMatches || node.children.some((child) => matchesFilter(child, category, search)))
  );
}

function flattenTree(
  root: TreeNodeReport,
  expanded: Set<string>,
  category: string,
  search: string,
): FlatNode[] {
  const output: FlatNode[] = [];
  const visit = (node: TreeNodeReport, depth: number) => {
    if (node !== root && !matchesFilter(node, category, search)) return;
    if (node !== root) output.push({ node, depth, moduleId: null });
    const open = node === root || expanded.has(node.id) || Boolean(search);
    if (open) {
      for (const child of [...node.children].sort(compareByUnusedBytesAndPath)) {
        visit(child, node === root ? 0 : depth + 1);
      }
    }
  };
  visit(root, 0);
  return output;
}

function moduleRows(
  files: SourceFileSummary[],
  modulesById: ReadonlyMap<string, BuildModule>,
  category: string,
  search: string,
  sort: ModuleSort,
): FlatNode[] {
  return sortModuleSources(files)
    .filter(
      (file) =>
        (category === "all" || file.category === category) &&
        (!search || file.path.toLowerCase().includes(search)),
    )
    .flatMap((file) =>
      file.moduleIds.map((moduleId) => {
        const module = modulesById.get(moduleId);
        return {
          depth: 0,
          moduleId,
          node: {
            id: `module:${moduleId}:${file.id}`,
            name: file.displayPath,
            path: file.path,
            kind: "file" as const,
            category: file.category,
            metrics: displayedModuleMetrics(file, module),
            chunks: module?.chunks ?? file.chunks,
            duplicated: file.duplicated,
            fileId: file.id,
            children: [],
          },
        };
      }),
    )
    .sort((left, right) => compareModuleRows(left, right, sort));
}

export function SourceExplorer(props: {
  tree: TreeNodeReport;
  files: SourceFileSummary[];
  modules?: BuildModule[];
  selectedFileId: string | null;
  selectedModuleId: string | null;
  onSelectFile: (file: SourceFileSummary, moduleId: string | null) => void;
}) {
  const [view, setView] = useState<SourceView>("modules");
  const [expanded, setExpanded] = useState(
    () => new Set(props.tree.children.slice(0, 4).map((node) => node.id)),
  );
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [moduleSort, setModuleSort] = useState<ModuleSort>(DEFAULT_MODULE_SORT);
  const scrollRef = useRef<HTMLDivElement>(null);
  const normalizedSearch = search.trim().toLowerCase();
  const modulesById = useMemo(
    () => new Map((props.modules ?? []).map((module) => [module.id, module])),
    [props.modules],
  );
  const rows = useMemo(
    () =>
      view === "modules"
        ? moduleRows(props.files, modulesById, category, normalizedSearch, moduleSort)
        : flattenTree(props.tree, expanded, category, normalizedSearch),
    [props.files, props.tree, modulesById, view, expanded, category, normalizedSearch, moduleSort],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 38,
    overscan: 12,
  });
  const filesById = useMemo(
    () => new Map(props.files.map((file) => [file.id, file])),
    [props.files],
  );

  const selectView = (nextView: SourceView) => {
    setView(nextView);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };

  const selectModuleSort = (key: ModuleSortKey) => {
    setModuleSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "desc" ? "asc" : "desc" }
        : { key, direction: key === "path" ? "asc" : "desc" },
    );
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };

  const sortHeader = (key: ModuleSortKey, label: string) => {
    const active = moduleSort.key === key;
    const direction = active ? moduleSort.direction : null;
    return (
      <button
        type="button"
        className={`tree-sort-button ${active ? "is-active" : ""}`}
        aria-label={`Sort modules by ${label}${direction ? `, ${direction === "asc" ? "ascending" : "descending"}` : ""}`}
        aria-pressed={active}
        onClick={() => selectModuleSort(key)}
      >
        {label}
        <i aria-hidden="true">{direction === "asc" ? "↑" : direction === "desc" ? "↓" : "↕"}</i>
      </button>
    );
  };

  return (
    <section className="panel source-explorer-panel">
      <div className="panel-header source-explorer-header">
        <div>
          <span className="eyebrow">Original sources</span>
          <h2>{view === "modules" ? "Modules" : "Directory tree"}</h2>
        </div>
        <div className="source-explorer-actions">
          <fieldset className="segmented">
            <legend className="sr-only">Source view</legend>
            <button
              type="button"
              className={view === "modules" ? "active" : ""}
              aria-pressed={view === "modules"}
              onClick={() => selectView("modules")}
            >
              Modules
            </button>
            <button
              type="button"
              className={view === "directory" ? "active" : ""}
              aria-pressed={view === "directory"}
              onClick={() => selectView("directory")}
            >
              Directory
            </button>
          </fieldset>
          <div className="tree-controls">
            <input
              aria-label="Search sources"
              placeholder="Search path…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <select
              aria-label="Source category"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            >
              <option value="all">All sources</option>
              <option value="first-party">First-party</option>
              <option value="node_modules">node_modules</option>
              <option value="runtime">Rspack runtime</option>
            </select>
          </div>
        </div>
      </div>
      <div className="tree-table-head">
        {view === "modules" ? (
          <>
            {sortHeader("path", "Path")}
            {sortHeader("loaded", "Loaded")}
            {sortHeader("unused", "Unused")}
            {sortHeader("usage", "Usage")}
            {sortHeader("chunks", "Chunks")}
          </>
        ) : (
          <>
            <span>Path</span>
            <span>Loaded</span>
            <span>Unexecuted</span>
            <span>Usage</span>
            <span>Chunks</span>
          </>
        )}
      </div>
      <div className="tree-scroll" ref={scrollRef}>
        <div className="virtual-canvas" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            const { node, depth, moduleId } = row;
            const open = expanded.has(node.id) || Boolean(normalizedSearch);
            const isFile = node.kind === "file";
            return (
              <button
                type="button"
                aria-label={
                  isFile
                    ? view === "modules"
                      ? `Open module ${node.path}`
                      : `Open source ${node.path}`
                    : `${open ? "Collapse" : "Expand"} directory ${node.path}`
                }
                aria-expanded={isFile ? undefined : open}
                className={`tree-row ${
                  node.fileId === props.selectedFileId && moduleId === props.selectedModuleId
                    ? "is-selected"
                    : ""
                }`}
                key={node.id}
                style={{ transform: `translateY(${virtualRow.start}px)` }}
                onClick={() => {
                  if (isFile && node.fileId) {
                    const file = filesById.get(node.fileId);
                    if (file) props.onSelectFile(file, moduleId);
                  } else {
                    const next = new Set(expanded);
                    if (next.has(node.id)) next.delete(node.id);
                    else next.add(node.id);
                    setExpanded(next);
                  }
                }}
              >
                <span
                  className="tree-path"
                  style={{ paddingLeft: `${12 + depth * 18}px` }}
                  title={moduleId ? `${node.path}\n${moduleId}` : node.path}
                >
                  <i
                    className={`usage-dot ${node.metrics.loadedBytes === 0 ? "is-not-loaded" : ""}`}
                    style={
                      node.metrics.loadedBytes === 0
                        ? undefined
                        : {
                            background: usageColor(
                              node.metrics.usageRatio,
                              node.metrics.loadedBytes,
                            ),
                          }
                    }
                  />
                  {!isFile ? (
                    <b className="disclosure">{open ? "−" : "+"}</b>
                  ) : view === "directory" ? (
                    <b className="file-mark">·</b>
                  ) : null}
                  <span>{node.name}</span>
                  {node.duplicated ? <em>duplicated</em> : null}
                </span>
                <span>{formatBytes(node.metrics.loadedBytes)}</span>
                <span className="unused-value">{formatBytes(node.metrics.unusedBytes)}</span>
                <span>{formatPercent(node.metrics.usageRatio)}</span>
                <span>{node.chunks.length}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="panel-footnote">
        {view === "modules"
          ? "Each row is a Rspack module instance. Sizes count retained original-source UTF-8 bytes once; tree-shaken/minified-away lines and not-loaded code are excluded from unused."
          : "Sizes are final generated UTF-8 bytes. Directory usage is byte-weighted."}
      </div>
    </section>
  );
}

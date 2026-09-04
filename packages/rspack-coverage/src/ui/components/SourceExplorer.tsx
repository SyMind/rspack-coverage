import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import { metricsForModuleInstance } from "../../shared/metrics.js";
import type { BuildModule, SourceFileSummary, TreeNodeReport } from "../../shared/types.js";
import { copyablePathProps } from "../lib/copyFullPath.js";
import { formatBytes, formatPercent, usageColor } from "../lib/format.js";
import { moduleDisplayIdentifier, moduleFullIdentifier } from "../lib/moduleIdentifier.js";

type SourceView = "modules" | "directory";
type UsageFilter = "all" | "positive";
type FlatNode = {
  node: TreeNodeReport;
  depth: number;
  moduleId: string | null;
  fullPath: string;
};
type SourceSortKey = "path" | "loaded" | "unused" | "usage" | "chunks";
type SortDirection = "asc" | "desc";
type SourceSort = { key: SourceSortKey; direction: SortDirection };

const DEFAULT_SOURCE_SORT: SourceSort = { key: "unused", direction: "desc" };

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

function compareSourceNodes(left: TreeNodeReport, right: TreeNodeReport, sort: SourceSort): number {
  let compared = 0;
  switch (sort.key) {
    case "path":
      compared = left.path.localeCompare(right.path);
      break;
    case "loaded":
      compared = left.metrics.loadedBytes - right.metrics.loadedBytes;
      break;
    case "unused":
      compared = left.metrics.unusedBytes - right.metrics.unusedBytes;
      break;
    case "usage": {
      const leftUsage = left.metrics.usageRatio;
      const rightUsage = right.metrics.usageRatio;
      if (leftUsage === null || rightUsage === null) {
        if (leftUsage !== rightUsage) return leftUsage === null ? 1 : -1;
      } else {
        compared = leftUsage - rightUsage;
      }
      break;
    }
    case "chunks":
      compared = left.chunks.length - right.chunks.length;
      break;
  }
  if (compared !== 0) return sort.direction === "asc" ? compared : -compared;
  return left.path.localeCompare(right.path);
}

function compareModuleRows(left: FlatNode, right: FlatNode, sort: SourceSort): number {
  if (sort.key === "path") {
    const compared = left.node.name.localeCompare(right.node.name);
    if (compared !== 0) return sort.direction === "asc" ? compared : -compared;
    return left.fullPath.localeCompare(right.fullPath);
  }
  return (
    compareSourceNodes(left.node, right.node, sort) ||
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

function matchesFilter(
  node: TreeNodeReport,
  category: string,
  search: string,
  usageFilter: UsageFilter,
): boolean {
  const categoryMatches =
    category === "all" || node.category === category || node.category === "mixed";
  const searchMatches = !search || node.path.toLowerCase().includes(search);
  const usageMatches = usageFilter === "all" || (node.metrics.usageRatio ?? 0) > 0;
  return (
    categoryMatches &&
    ((searchMatches && usageMatches) ||
      node.children.some((child) => matchesFilter(child, category, search, usageFilter)))
  );
}

function flattenTree(
  root: TreeNodeReport,
  expanded: Set<string>,
  category: string,
  search: string,
  usageFilter: UsageFilter,
  sort: SourceSort,
): FlatNode[] {
  const output: FlatNode[] = [];
  const visit = (node: TreeNodeReport, depth: number) => {
    if (node !== root && !matchesFilter(node, category, search, usageFilter)) return;
    if (node !== root) output.push({ node, depth, moduleId: null, fullPath: node.path });
    const open = node === root || expanded.has(node.id) || Boolean(search);
    if (open) {
      for (const child of [...node.children].sort((left, right) =>
        compareSourceNodes(left, right, sort),
      )) {
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
  usageFilter: UsageFilter,
  sort: SourceSort,
): FlatNode[] {
  return sortModuleSources(files)
    .filter((file) => category === "all" || file.category === category)
    .flatMap((file) =>
      file.moduleIds.map((moduleId) => {
        const module = modulesById.get(moduleId);
        const displayIdentifier = module ? moduleDisplayIdentifier(module) : file.displayPath;
        const fullPath = module ? moduleFullIdentifier(module) : file.path;
        return {
          depth: 0,
          moduleId,
          fullPath,
          node: {
            id: `module:${moduleId}:${file.id}`,
            name: displayIdentifier,
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
    .filter(
      ({ node, fullPath }) =>
        (usageFilter === "all" || (node.metrics.usageRatio ?? 0) > 0) &&
        (!search ||
          [node.name, node.path, fullPath].some((value) => value.toLowerCase().includes(search))),
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
  const [expanded, setExpanded] = useState(() => new Set<string>());
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [usageFilter, setUsageFilter] = useState<UsageFilter>("all");
  const [sort, setSort] = useState<SourceSort>(DEFAULT_SOURCE_SORT);
  const scrollRef = useRef<HTMLDivElement>(null);
  const normalizedSearch = search.trim().toLowerCase();
  const modulesById = useMemo(
    () => new Map((props.modules ?? []).map((module) => [module.id, module])),
    [props.modules],
  );
  const rows = useMemo(
    () =>
      view === "modules"
        ? moduleRows(props.files, modulesById, category, normalizedSearch, usageFilter, sort)
        : flattenTree(props.tree, expanded, category, normalizedSearch, usageFilter, sort),
    [
      props.files,
      props.tree,
      modulesById,
      view,
      expanded,
      category,
      normalizedSearch,
      usageFilter,
      sort,
    ],
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

  const selectSort = (key: SourceSortKey) => {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "desc" ? "asc" : "desc" }
        : { key, direction: key === "path" ? "asc" : "desc" },
    );
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };

  const sortHeader = (key: SourceSortKey, label: string) => {
    const active = sort.key === key;
    const direction = active ? sort.direction : null;
    const scope = view === "modules" ? "modules" : "directory tree";
    return (
      <button
        type="button"
        className={`tree-sort-button ${active ? "is-active" : ""}`}
        aria-label={`Sort ${scope} by ${label}${direction ? `, ${direction === "asc" ? "ascending" : "descending"}` : ""}`}
        aria-pressed={active}
        onClick={() => selectSort(key)}
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
            <button
              type="button"
              className={`usage-filter-toggle ${usageFilter === "positive" ? "active" : ""}`}
              aria-pressed={usageFilter === "positive"}
              onClick={() => setUsageFilter((current) => (current === "all" ? "positive" : "all"))}
            >
              Usage &gt; 0%
            </button>
          </div>
        </div>
      </div>
      <div className="tree-table-head">
        {sortHeader("path", "Path")}
        {sortHeader("loaded", "Loaded")}
        {sortHeader("unused", view === "modules" ? "Unused" : "Unexecuted")}
        {sortHeader("usage", "Usage")}
        {sortHeader("chunks", "Chunks")}
      </div>
      <div className="tree-scroll" ref={scrollRef}>
        <div className="virtual-canvas" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            const { node, depth, moduleId, fullPath } = row;
            const open = expanded.has(node.id) || Boolean(normalizedSearch);
            const isFile = node.kind === "file";
            return (
              <button
                type="button"
                aria-label={
                  isFile
                    ? view === "modules"
                      ? `Open module ${node.name}`
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
                <span className="tree-path" style={{ paddingLeft: `${12 + depth * 18}px` }}>
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
                  <span {...copyablePathProps(fullPath)}>{node.name}</span>
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

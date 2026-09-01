import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import type { SourceFileReport, TreeNodeReport } from "../../shared/types.js";
import { formatBytes, formatPercent, usageColor } from "../lib/format.js";

type SourceView = "modules" | "directory";
type SourceSort = "name" | "coverage" | "size" | "unused";
type FlatNode = { node: TreeNodeReport; depth: number };

function compareByUnusedBytesAndPath(
  left: Pick<SourceFileReport, "path" | "metrics">,
  right: Pick<SourceFileReport, "path" | "metrics">,
): number {
  return (
    right.metrics.unusedBytes - left.metrics.unusedBytes || left.path.localeCompare(right.path)
  );
}

export function sortModuleSources(files: SourceFileReport[]): SourceFileReport[] {
  return [...files].sort(compareByUnusedBytesAndPath);
}

function compareSources(
  left: Pick<SourceFileReport, "path" | "metrics">,
  right: Pick<SourceFileReport, "path" | "metrics">,
  sort: SourceSort,
): number {
  if (sort === "name") return left.path.localeCompare(right.path);
  if (sort === "coverage") {
    return (
      (left.metrics.usageRatio ?? -1) - (right.metrics.usageRatio ?? -1) ||
      left.path.localeCompare(right.path)
    );
  }
  if (sort === "size") {
    return (
      right.metrics.emittedBytes - left.metrics.emittedBytes || left.path.localeCompare(right.path)
    );
  }
  return compareByUnusedBytesAndPath(left, right);
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
  sort: SourceSort,
): FlatNode[] {
  const output: FlatNode[] = [];
  const visit = (node: TreeNodeReport, depth: number) => {
    if (node !== root && !matchesFilter(node, category, search)) return;
    if (node !== root) output.push({ node, depth });
    const open = node === root || expanded.has(node.id) || Boolean(search);
    if (open) {
      for (const child of [...node.children].sort((left, right) =>
        compareSources(left, right, sort),
      )) {
        visit(child, node === root ? 0 : depth + 1);
      }
    }
  };
  visit(root, 0);
  return output;
}

function moduleRows(
  files: SourceFileReport[],
  category: string,
  search: string,
  sort: SourceSort,
): FlatNode[] {
  return [...files]
    .sort((left, right) => compareSources(left, right, sort))
    .filter(
      (file) =>
        (category === "all" || file.category === category) &&
        (!search || file.path.toLowerCase().includes(search)),
    )
    .map((file) => ({
      depth: 0,
      node: {
        id: `module:${file.id}`,
        name: file.displayPath,
        path: file.path,
        kind: "file",
        category: file.category,
        metrics: file.metrics,
        chunks: file.chunks,
        duplicated: file.duplicated,
        fileId: file.id,
        children: [],
      },
    }));
}

export function SourceExplorer(props: {
  tree: TreeNodeReport;
  files: SourceFileReport[];
  selectedFileId: string | null;
  onSelectFile: (file: SourceFileReport) => void;
}) {
  const [view, setView] = useState<SourceView>("modules");
  const [expanded, setExpanded] = useState(
    () => new Set(props.tree.children.slice(0, 4).map((node) => node.id)),
  );
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState<SourceSort>("size");
  const scrollRef = useRef<HTMLDivElement>(null);
  const normalizedSearch = search.trim().toLowerCase();
  const rows = useMemo(
    () =>
      view === "modules"
        ? moduleRows(props.files, category, normalizedSearch, sort)
        : flattenTree(props.tree, expanded, category, normalizedSearch, sort),
    [props.files, props.tree, view, expanded, category, normalizedSearch, sort],
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
            <select
              aria-label="Source sort"
              value={sort}
              onChange={(event) => setSort(event.target.value as SourceSort)}
            >
              <option value="name">Name</option>
              <option value="coverage">Coverage</option>
              <option value="size">Generated size</option>
              <option value="unused">Unexecuted bytes</option>
            </select>
          </div>
        </div>
      </div>
      <div className="tree-table-head">
        <span>Path</span>
        <span>Loaded</span>
        <span>Unused</span>
        <span>Usage</span>
        <span>Chunks</span>
      </div>
      <div className="tree-scroll" ref={scrollRef}>
        <div className="virtual-canvas" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (!row) return null;
            const { node, depth } = row;
            const open = expanded.has(node.id) || Boolean(normalizedSearch);
            const isFile = node.kind === "file";
            return (
              <button
                type="button"
                aria-label={
                  isFile
                    ? `Open source ${node.path}`
                    : `${open ? "Collapse" : "Expand"} directory ${node.path}`
                }
                aria-expanded={isFile ? undefined : open}
                className={`tree-row ${node.fileId === props.selectedFileId ? "is-selected" : ""}`}
                key={node.id}
                style={{ transform: `translateY(${virtualRow.start}px)` }}
                onClick={() => {
                  if (isFile && node.fileId) {
                    const file = filesById.get(node.fileId);
                    if (file) props.onSelectFile(file);
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
                  title={node.path}
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
          ? "Each row is an original source-map source. Sort and coverage use generated-byte evidence."
          : "Sizes are final generated UTF-8 bytes. Directory usage is byte-weighted."}
      </div>
    </section>
  );
}

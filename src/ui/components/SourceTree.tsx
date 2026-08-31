import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import type { SourceFileReport, TreeNodeReport } from "../../shared/types.js";
import { formatBytes, formatPercent, usageColor } from "../lib/format.js";

type FlatNode = { node: TreeNodeReport; depth: number };

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
    if (node !== root) output.push({ node, depth });
    const open = node === root || expanded.has(node.id) || Boolean(search);
    if (open) for (const child of node.children) visit(child, node === root ? 0 : depth + 1);
  };
  visit(root, 0);
  return output;
}

export function SourceTree(props: {
  tree: TreeNodeReport;
  files: SourceFileReport[];
  selectedFileId: string | null;
  onSelectFile: (file: SourceFileReport) => void;
}) {
  const [expanded, setExpanded] = useState(
    () => new Set(props.tree.children.slice(0, 4).map((node) => node.id)),
  );
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(
    () => flattenTree(props.tree, expanded, category, search.trim().toLowerCase()),
    [props.tree, expanded, category, search],
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

  return (
    <section className="panel source-tree-panel">
      <div className="panel-header">
        <div>
          <span className="eyebrow">Original sources</span>
          <h2>Directory tree</h2>
        </div>
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
            const open = expanded.has(node.id) || Boolean(search);
            return (
              <button
                type="button"
                className={`tree-row ${node.fileId === props.selectedFileId ? "is-selected" : ""}`}
                key={node.id}
                style={{ transform: `translateY(${virtualRow.start}px)` }}
                onClick={() => {
                  if (node.kind === "file" && node.fileId) {
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
                  {node.kind === "directory" ? (
                    <b className="disclosure">{open ? "−" : "+"}</b>
                  ) : (
                    <b className="file-mark">·</b>
                  )}
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
        Sizes are final generated UTF-8 bytes. Directory usage is byte-weighted.
      </div>
    </section>
  );
}

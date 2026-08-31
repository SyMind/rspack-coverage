import { hierarchy, treemap } from "d3-hierarchy";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SourceFileReport, TreeNodeReport } from "../../shared/types.js";
import { formatBytes, formatPercent, usageColor } from "../lib/format.js";

type MetricKey = "loadedBytes" | "unusedBytes" | "emittedBytes";

function useSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ width: 700, height: 500 });
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

export function TreemapView(props: {
  tree: TreeNodeReport;
  files: SourceFileReport[];
  onSelectFile: (file: SourceFileReport) => void;
}) {
  const [metric, setMetric] = useState<MetricKey>("loadedBytes");
  const [focusPath, setFocusPath] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const size = useSize(containerRef);
  const fileById = useMemo(
    () => new Map(props.files.map((file) => [file.id, file])),
    [props.files],
  );
  const focusNode = useMemo(() => {
    const find = (node: TreeNodeReport): TreeNodeReport | null => {
      if (node.path === focusPath) return node;
      for (const child of node.children) {
        const result = find(child);
        if (result) return result;
      }
      return null;
    };
    return find(props.tree) ?? props.tree;
  }, [props.tree, focusPath]);
  const leaves = useMemo(() => {
    const root = hierarchy(focusNode)
      .sum((node) => Math.max(0, node.metrics[metric]))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    const layout = treemap<TreeNodeReport>()
      .size([Math.max(0, size.width), Math.max(0, size.height)])
      .paddingInner(2)
      .paddingOuter(1)
      .round(true)(root);
    return layout.leaves();
  }, [focusNode, metric, size]);

  return (
    <section className="panel treemap-panel">
      <div className="panel-header">
        <div>
          <span className="eyebrow">Spatial overview</span>
          <h2>Treemap</h2>
        </div>
        <div className="segmented">
          {(["loadedBytes", "unusedBytes", "emittedBytes"] as const).map((key) => (
            <button
              type="button"
              key={key}
              className={metric === key ? "active" : ""}
              onClick={() => setMetric(key)}
            >
              {key === "loadedBytes" ? "Loaded" : key === "unusedBytes" ? "Unused" : "Emitted"}
            </button>
          ))}
        </div>
      </div>
      <div className="treemap-breadcrumb">
        <button type="button" onClick={() => setFocusPath("")}>
          Sources
        </button>
        {focusPath ? (
          <>
            <span>/</span>
            <span>{focusPath}</span>
          </>
        ) : (
          <span>· double-click a directory area to focus</span>
        )}
      </div>
      <div className="treemap-canvas" ref={containerRef}>
        <svg width={size.width} height={size.height} role="img" aria-label="Source usage treemap">
          <defs>
            <pattern
              id="not-loaded-pattern"
              width="8"
              height="8"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect width="8" height="8" fill="#d9ddd7" />
              <line x1="0" y1="0" x2="0" y2="8" stroke="#b4bbb3" strokeWidth="3" />
            </pattern>
          </defs>
          {leaves.map((leaf) => {
            const data = leaf.data;
            const width = leaf.x1 - leaf.x0;
            const height = leaf.y1 - leaf.y0;
            const parentPath = data.path.split("/").slice(0, -1).join("/");
            return (
              <a
                key={data.id}
                aria-label={`Open ${data.path}`}
                href={`#source=${encodeURIComponent(data.path)}`}
                onClick={(event) => {
                  event.preventDefault();
                  if (data.fileId) {
                    const file = fileById.get(data.fileId);
                    if (file) props.onSelectFile(file);
                  }
                }}
                onDoubleClick={() => setFocusPath(parentPath)}
              >
                <g transform={`translate(${leaf.x0},${leaf.y0})`} className="treemap-cell">
                  <title>{`${data.path}\nLoaded ${formatBytes(data.metrics.loadedBytes)}\nExecuted ${formatBytes(data.metrics.executedBytes)}\nUnused ${formatBytes(data.metrics.unusedBytes)}\nUsage ${formatPercent(data.metrics.usageRatio)}\n${data.chunks.length} chunks`}</title>
                  <rect
                    width={Math.max(0, width)}
                    height={Math.max(0, height)}
                    rx="3"
                    fill={
                      data.metrics.loadedBytes === 0
                        ? "url(#not-loaded-pattern)"
                        : usageColor(data.metrics.usageRatio, data.metrics.loadedBytes)
                    }
                  />
                  {width > 70 && height > 32 ? (
                    <>
                      <text x="8" y="17">
                        {data.name.slice(0, Math.max(5, Math.floor(width / 8)))}
                      </text>
                      {height > 50 ? (
                        <text className="treemap-value" x="8" y="35">
                          {formatBytes(data.metrics[metric])}
                        </text>
                      ) : null}
                    </>
                  ) : null}
                </g>
              </a>
            );
          })}
        </svg>
      </div>
      <div className="treemap-legend">
        <span className="legend-low" /> low usage <span className="legend-high" /> high usage{" "}
        <span className="legend-not-loaded" /> not loaded
      </div>
    </section>
  );
}

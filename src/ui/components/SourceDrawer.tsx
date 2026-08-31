import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";
import type { SourceFileReport, SourceLineState } from "../../shared/types.js";
import { formatBytes, formatPercent } from "../lib/format.js";

function buildLabel(line: SourceLineState): string {
  if (line.buildState === "not-emitted") return "Removed from final generated output";
  if (line.runtimeState === "not-loaded") return "Retained, but its chunk was not loaded";
  if (line.runtimeState === "not-executed") return "Retained and loaded, but not executed";
  if (line.runtimeState === "partial") return "Partially executed mapped ranges";
  return "Executed mapped ranges";
}

export function SourceDrawer(props: { file: SourceFileReport | null; onClose: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = props.file?.lines ?? [];
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 24,
    overscan: 30,
  });
  if (!props.file) return null;
  const file = props.file;
  return (
    <div className="drawer-backdrop">
      <aside className="source-drawer" aria-label={`Source details for ${file.path}`}>
        <header>
          <div>
            <span className="eyebrow">Original source</span>
            <h2>{file.path.split("/").at(-1)}</h2>
            <code>{file.path}</code>
          </div>
          <button
            type="button"
            className="close-button"
            onClick={props.onClose}
            aria-label="Close source details"
          >
            ×
          </button>
        </header>
        <div className="drawer-metrics">
          <span>
            <small>Loaded</small>
            {formatBytes(file.metrics.loadedBytes)}
          </span>
          <span>
            <small>Executed</small>
            {formatBytes(file.metrics.executedBytes)}
          </span>
          <span>
            <small>Unused</small>
            {formatBytes(file.metrics.unusedBytes)}
          </span>
          <span>
            <small>Usage</small>
            {formatPercent(file.metrics.usageRatio)}
          </span>
          <span>
            <small>Mapped</small>
            {formatPercent(
              file.metrics.emittedBytes
                ? file.metrics.mappedBytes / file.metrics.emittedBytes
                : null,
            )}
          </span>
        </div>
        <div className="source-legend">
          <span>
            <i className="swatch executed" /> executed
          </span>
          <span>
            <i className="swatch unused" /> loaded / unexecuted
          </span>
          <span>
            <i className="swatch not-loaded" /> not loaded
          </span>
          <span>
            <i className="swatch not-emitted" /> not emitted
          </span>
        </div>
        <div className="source-columns">
          <span>B</span>
          <span>R</span>
          <span>Line</span>
          <span>Source</span>
        </div>
        <div className="source-scroll" ref={scrollRef}>
          <div className="virtual-canvas" style={{ height: `${virtualizer.getTotalSize()}px` }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const line = lines[virtualRow.index];
              if (!line) return null;
              return (
                <div
                  className={`source-line build-${line.buildState} runtime-${line.runtimeState}`}
                  key={line.line}
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                  title={`${buildLabel(line)} · generated ${formatBytes(line.emittedBytes)} · executed ${formatBytes(line.executedBytes)} · chunks ${line.chunks.join(", ") || "none"}`}
                >
                  <span className="build-gutter">
                    {line.buildState === "retained"
                      ? "●"
                      : line.buildState === "not-emitted"
                        ? "×"
                        : "·"}
                  </span>
                  <span className="runtime-gutter">
                    {line.runtimeState === "executed"
                      ? "●"
                      : line.runtimeState === "partial"
                        ? "◐"
                        : line.runtimeState === "not-executed"
                          ? "○"
                          : "·"}
                  </span>
                  <span className="line-number">{line.line}</span>
                  <code>{line.text || " "}</code>
                </div>
              );
            })}
          </div>
        </div>
        <footer>
          Build status comes from final source-map mappings. It does not infer whether tree shaking,
          code generation, or minification removed a line.
        </footer>
      </aside>
    </div>
  );
}

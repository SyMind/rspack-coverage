import type { ChunkReport } from "../../shared/types.js";
import { formatBytes, formatPercent } from "../lib/format.js";

export function ChunksView(props: { chunks: ChunkReport[] }) {
  const chunks = [...props.chunks].sort(
    (a, b) => Number(b.loaded) - Number(a.loaded) || b.metrics.unusedBytes - a.metrics.unusedBytes,
  );
  return (
    <section className="panel data-panel">
      <div className="panel-header">
        <div>
          <span className="eyebrow">Compilation × recording</span>
          <h2>Chunks</h2>
        </div>
        <p>
          Loaded means at least one JavaScript asset associated with the chunk appeared in Chrome
          Coverage.
        </p>
      </div>
      <div className="data-table chunk-table">
        <div className="data-row data-head">
          <span>Chunk</span>
          <span>Type</span>
          <span>Status</span>
          <span>Emitted</span>
          <span>Unused</span>
          <span>Usage</span>
          <span>Modules</span>
        </div>
        {chunks.map((chunk) => (
          <div className={`data-row ${chunk.loaded ? "" : "is-not-loaded"}`} key={chunk.id}>
            <span className="chunk-name">
              <strong>{chunk.names[0] ?? `Chunk ${chunk.id}`}</strong>
              <small>{chunk.files.join(", ") || "No JavaScript asset"}</small>
            </span>
            <span>
              <span className={`pill ${chunk.initial ? "pill--initial" : ""}`}>
                {chunk.initial ? "Initial" : "Async"}
              </span>
            </span>
            <span>
              <span className={`status ${chunk.loaded ? "status--loaded" : ""}`}>
                {chunk.loaded ? "Loaded" : "Not loaded"}
              </span>
            </span>
            <span>{formatBytes(chunk.metrics.emittedBytes)}</span>
            <span className="unused-value">
              {chunk.loaded ? formatBytes(chunk.metrics.unusedBytes) : "—"}
            </span>
            <span>{formatPercent(chunk.metrics.usageRatio)}</span>
            <span>
              {chunk.moduleIds.length.toLocaleString()}
              {chunk.duplicatedSources ? (
                <small className="duplicate-note">{chunk.duplicatedSources} duplicated</small>
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

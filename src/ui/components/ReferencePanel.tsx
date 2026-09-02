import { useEffect, useRef } from "react";
import type {
  CodeCoverageState,
  CodeViewResponse,
  ExportModuleInstance,
  ExportUsagePrecision,
  ExportUsageState,
  ModuleReferencesResponse,
  ReferenceEdgeReport,
  ReferenceSnippetResponse,
  SourceExportUsage,
} from "../../shared/types.js";
import { formatPercent } from "../lib/format.js";
import { CoverageCode } from "./CoverageCode.js";

const STATUS_LABELS: Record<CodeCoverageState, string> = {
  executed: "Executed",
  unexecuted: "Loaded / unexecuted",
  "not-emitted": "Not emitted",
  unloaded: "Not loaded",
  unknown: "Unknown",
  neutral: "No coverage evidence",
};

const EXPORT_STATE_LABELS: Record<ExportUsageState, string> = {
  used: "Used",
  unused: "Unused",
  unknown: "Unknown",
  "type-only": "Type only",
};

const PRECISION_LABELS: Record<ExportUsagePrecision, string> = {
  exact: "Exact",
  conservative: "Conservative",
  unavailable: "Unavailable",
};

function shortName(value: string, maximum = 31): string {
  const name = value.split(/[\\/]/).at(-1) ?? value;
  return name.length > maximum ? `${name.slice(0, maximum - 1)}…` : name;
}

function edgeNeighbor(edge: ReferenceEdgeReport, selectedId: string) {
  return edge.originId === selectedId ? edge.target : edge.origin;
}

function referenceLocation(line: number | null, column: number | null): string {
  if (line === null) return "location unavailable";
  return column === null ? `line ${line}` : `${line}:${column + 1}`;
}

function legacySnippetCode(snippet: ReferenceSnippetResponse): CodeViewResponse | null {
  if (snippet.code) return snippet.code;
  if (snippet.content === undefined) return null;
  const content = snippet.content;
  const status = snippet.highlight?.coverageStatus ?? "unknown";
  return {
    view: "source",
    sourceId: null,
    filename: snippet.filename ?? "Unavailable",
    language: "javascript",
    content,
    spans: content ? [{ start: 0, end: content.length, status }] : [],
    offset: 0,
    endOffset: content.length,
    startLine: snippet.startLine ?? 1,
    totalCharacters: content.length,
    hasPrevious: false,
    hasNext: false,
    provenance: "reference-snippet",
    gap: snippet.gap,
  };
}

function moduleGraphOptionLabel(
  instance: ExportModuleInstance,
  references: ModuleReferencesResponse | null,
): string {
  const name =
    references?.module.id === instance.moduleId
      ? references.module.name
      : shortName(instance.resource ?? instance.identifier, 48);
  return instance.chunks.length
    ? `Chunk graph ${instance.chunks.join(", ")} · ${shortName(name, 48)}`
    : `Unchunked graph · ${shortName(name, 48)}`;
}

function directionLabel(direction: "in" | "out" | "both"): string {
  return direction === "in" ? "Importers" : direction === "out" ? "Dependencies" : "All";
}

function directionEdgeLabel(direction: "in" | "out" | "both", count: number | null): string {
  const value = count === null ? "—" : count.toLocaleString();
  const edge = count === 1 ? "edge" : "edges";
  return direction === "in"
    ? `${value} importer ${edge}`
    : direction === "out"
      ? `${value} dependency ${edge}`
      : `${value} total ${edge}`;
}

function emptyDirectionLabel(direction: "in" | "out" | "both"): string {
  return direction === "in"
    ? "No importer uses this export"
    : direction === "out"
      ? "No dependency edges captured"
      : "No module edges captured";
}

function SnippetCard(props: {
  snippet: ReferenceSnippetResponse | null;
  flashKey: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!props.snippet) return;
    if (ref.current) ref.current.dataset.flashKey = String(props.flashKey);
    ref.current?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }, [props.snippet, props.flashKey]);
  if (!props.snippet) return null;
  const snippet = props.snippet;
  const code = legacySnippetCode(snippet);
  const status = snippet.highlight?.coverageStatus ?? "unknown";
  const location = snippet.location;
  return (
    <div className="reference-snippet reference-coverage-detail" ref={ref}>
      <header>
        <div>
          <span>Usage location</span>
          <strong title={code?.filename ?? snippet.filename}>
            {code?.filename ?? snippet.filename ?? "Unavailable"}
          </strong>
        </div>
        <button type="button" aria-label="Close usage location" onClick={props.onClose}>
          ×
        </button>
      </header>
      {snippet.available ? (
        <>
          <div className="snippet-facts">
            <span className={`coverage-badge coverage-${status}`}>{STATUS_LABELS[status]}</span>
            <span>
              Module usage {formatPercent(snippet.coverage?.usageRatio ?? null)} · use at line{" "}
              {location?.start.line ?? "—"}
            </span>
          </div>
          <div className="coverage-code-legend">
            <span>
              <i className="legend-executed" /> executed
            </span>
            <span>
              <i className="legend-unexecuted" /> loaded / unexecuted
            </span>
            <span>
              <i className="legend-unloaded" /> not loaded
            </span>
            <span>
              <i className="legend-not-emitted" /> not emitted
            </span>
            <span>
              <i className="legend-unknown" /> unknown
            </span>
          </div>
          {code ? (
            <div className="coverage-code-scroll reference-coverage-scroll">
              <CoverageCode
                code={code}
                highlight={
                  snippet.highlight
                    ? {
                        start: snippet.highlight.start,
                        end: snippet.highlight.end,
                        flashKey: props.flashKey,
                      }
                    : null
                }
              />
            </div>
          ) : (
            <p>Full source code is unavailable.</p>
          )}
        </>
      ) : (
        <p>{snippet.gap}</p>
      )}
    </div>
  );
}

export function ReferencePanel(props: {
  exportUsage: SourceExportUsage | null;
  moduleInstance: ExportModuleInstance | null;
  references: ModuleReferencesResponse | null;
  direction: "in" | "out" | "both";
  loading: boolean;
  error: string | null;
  snippet: ReferenceSnippetResponse | null;
  snippetFlashKey: number;
  onDirectionChange: (direction: "in" | "out" | "both") => void;
  onSelectEdge: (edgeId: string) => void;
  onLoadMore: () => void;
  onModuleChange: (moduleId: string) => void;
  onClose?: () => void;
  onCloseSnippet: () => void;
}) {
  const references = props.references;
  const exportUsage = props.exportUsage;
  const selectedModuleId = references?.module.id ?? props.moduleInstance?.moduleId ?? "";
  const selectedExportReferences =
    exportUsage?.references.filter((reference) => reference.targetModuleId === selectedModuleId) ??
    [];
  const selectedReferenceCount = exportUsage
    ? (exportUsage.referenceCountByModule[selectedModuleId] ?? selectedExportReferences.length)
    : (references?.counts.in ?? 0);
  const directReferenceModules = new Set(
    selectedExportReferences.map((reference) => reference.moduleId),
  );
  const explicitReferenceModules = new Set(
    references?.edges
      .filter(
        (edge) =>
          edge.targetId === selectedModuleId &&
          exportUsage &&
          edge.exports?.includes(exportUsage.exportedName),
      )
      .map((edge) => edge.originId) ?? [],
  );
  const edgeMatchesExport = (edge: ReferenceEdgeReport) =>
    Boolean(
      exportUsage &&
        edge.active !== false &&
        edge.targetId === selectedModuleId &&
        (edge.exports?.includes(exportUsage.exportedName) ||
          (!edge.exports?.length &&
            directReferenceModules.has(edge.originId) &&
            !explicitReferenceModules.has(edge.originId))),
    );
  const matchingEdge = (originModuleId: string) =>
    references?.edges.find(
      (edge) =>
        edge.originId === originModuleId &&
        edge.targetId === selectedModuleId &&
        edgeMatchesExport(edge),
    );
  const displayedEdges =
    props.direction === "in" && exportUsage
      ? (references?.edges.filter(edgeMatchesExport) ?? [])
      : (references?.edges ?? []);
  const visibleEdges = displayedEdges.slice(0, 12);
  const moduleLabel =
    references?.module.name ??
    (props.moduleInstance ? shortName(props.moduleInstance.identifier, 44) : "Module unavailable");
  const directionCounts = references ? { ...references.counts, in: selectedReferenceCount } : null;
  const currentDirectionCount = directionCounts?.[props.direction] ?? null;
  return (
    <aside className="reference-workbench" aria-label="Export references and module graph">
      <div className="reference-toolbar">
        <div>
          <span className="eyebrow">Export investigation</span>
          <h3>{exportUsage?.exportedName ?? "Export reference chain"}</h3>
        </div>
        <div className="reference-toolbar-actions">
          <span className="reference-count" title="Direct importer references">
            {exportUsage ? selectedReferenceCount.toLocaleString() : "—"}
          </span>
          {props.onClose ? (
            <button
              type="button"
              className="reference-close-button"
              aria-label="Back to source code"
              onClick={props.onClose}
            >
              ×
            </button>
          ) : null}
        </div>
      </div>

      {exportUsage ? (
        <section className="export-reference-chain" aria-label="Export importer chain">
          <div className="export-chain-summary">
            <div>
              <span className="eyebrow">Importer chain</span>
              <strong>{exportUsage.exportedName}</strong>
            </div>
            <span className={`export-state state-${exportUsage.state}`}>
              {EXPORT_STATE_LABELS[exportUsage.state]}
            </span>
          </div>
          <div className="export-chain-facts">
            <span>
              <small>Precision</small>
              {PRECISION_LABELS[exportUsage.precision]}
            </span>
            <span>
              <small>Direct refs</small>
              {selectedReferenceCount.toLocaleString()}
            </span>
            <span>
              <small>Modules</small>
              {exportUsage.moduleInstances.length.toLocaleString()}
            </span>
          </div>
          {selectedExportReferences.length ? (
            <div className="export-reference-list">
              {selectedExportReferences.map((reference, index) => {
                const edge = matchingEdge(reference.moduleId);
                const key = `${reference.moduleId}:${reference.line}:${reference.column}:${index}`;
                const content = (
                  <>
                    <span>← importer · {reference.dependencyType || "module reference"}</span>
                    <strong title={reference.path}>{reference.path}</strong>
                    <small>
                      {referenceLocation(reference.line, reference.column)} ·{" "}
                      {reference.referencedPath?.join(".") || reference.request || "export usage"}
                    </small>
                    {reference.snippet ? <code>{reference.snippet}</code> : null}
                  </>
                );
                return edge ? (
                  <button
                    type="button"
                    key={key}
                    onClick={() => props.onSelectEdge(edge.id)}
                    aria-label={`Open importer usage ${reference.path}`}
                  >
                    {content}
                  </button>
                ) : (
                  <div key={key}>{content}</div>
                );
              })}
            </div>
          ) : selectedReferenceCount > 0 ? (
            <div className="export-chain-empty">
              {selectedReferenceCount.toLocaleString()} importer references were captured for this
              module graph, but their location details are outside the retained preview.
            </div>
          ) : (
            <div className="export-chain-empty">
              No importer uses this export in the selected module graph. Structural module edges
              remain available below.
            </div>
          )}
          {exportUsage.truncated ? (
            <div className="export-chain-note">
              Only the first captured direct references are shown.
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="module-graph-toolbar">
        <div>
          <span className="eyebrow">Corresponding module graph</span>
          <strong title={references?.module.identifier ?? props.moduleInstance?.identifier}>
            {moduleLabel}
          </strong>
        </div>
        <span>{directionEdgeLabel(props.direction, currentDirectionCount)}</span>
      </div>
      {exportUsage && exportUsage.moduleInstances.length > 1 ? (
        <label className="module-graph-picker">
          Module graph
          <select
            value={props.moduleInstance?.moduleId ?? selectedModuleId}
            onChange={(event) => props.onModuleChange(event.target.value)}
          >
            {exportUsage.moduleInstances.map((instance) => (
              <option value={instance.moduleId} key={instance.moduleId}>
                {moduleGraphOptionLabel(instance, references)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <fieldset className="segmented reference-direction">
        <legend className="sr-only">Reference direction</legend>
        {(["in", "both", "out"] as const).map((direction) => (
          <button
            type="button"
            className={props.direction === direction ? "active" : ""}
            key={direction}
            aria-label={`${directionLabel(direction)}: ${directionCounts?.[direction].toLocaleString() ?? "unknown"} ${directionCounts?.[direction] === 1 ? "edge" : "edges"}`}
            onClick={() => props.onDirectionChange(direction)}
          >
            <span>{directionLabel(direction)}</span>
            <small>{directionCounts?.[direction].toLocaleString() ?? "—"}</small>
          </button>
        ))}
      </fieldset>
      {references?.entryPath.length ? (
        <nav className="entry-path" aria-label="Shortest path to an entry">
          <small>Shortest path to entry</small>
          <div>
            {references.entryPath.map((module, index) => (
              <span key={module.id} title={module.identifier}>
                {index ? "→ " : ""}
                {shortName(module.name, 22)}
              </span>
            ))}
          </div>
        </nav>
      ) : null}
      <div className="reference-graph-wrap">
        {props.loading ? <div className="reference-loading">Loading references…</div> : null}
        {props.error ? <div className="reference-error">{props.error}</div> : null}
        {selectedModuleId ? (
          <svg className="reference-graph" viewBox="0 0 520 330" role="img">
            <title>
              {props.direction === "in"
                ? "Importers using the current module export"
                : "Corresponding module and its structural module edges"}
            </title>
            <rect className="graph-center" x="170" y="135" width="180" height="58" rx="10" />
            <text className="graph-label graph-label-center" x="260" y="159" textAnchor="middle">
              {shortName(moduleLabel, 27)}
            </text>
            <text className="graph-export graph-export-center" x="260" y="177" textAnchor="middle">
              {exportUsage?.exportedName ?? "module"}
            </text>
            {visibleEdges.map((edge) => {
              const incoming = edge.targetId === selectedModuleId;
              const sideEdges = visibleEdges.filter(
                (candidate) => (candidate.targetId === selectedModuleId) === incoming,
              );
              const sideIndex = sideEdges.findIndex((candidate) => candidate.id === edge.id);
              const x = incoming ? 8 : 372;
              const y = 18 + sideIndex * Math.min(62, 285 / Math.max(1, sideEdges.length));
              const lineStartX = incoming ? x + 140 : 350;
              const lineEndX = incoming ? 170 : x;
              const lineY = y + 22;
              const lineStartY = incoming ? lineY : 164;
              const lineEndY = incoming ? 164 : lineY;
              const neighbor = edgeNeighbor(edge, selectedModuleId);
              return (
                <a
                  className={`graph-node${edgeMatchesExport(edge) ? " is-export-edge" : ""}`}
                  key={edge.id}
                  href={`#reference-${edge.id}`}
                  aria-label={`Show usage ${neighbor.name}`}
                  onClick={(event) => {
                    event.preventDefault();
                    props.onSelectEdge(edge.id);
                  }}
                >
                  <line
                    className="graph-edge"
                    x1={lineStartX}
                    y1={lineStartY}
                    x2={lineEndX}
                    y2={lineEndY}
                  />
                  <rect x={x} y={y} width="140" height="44" rx="8" />
                  <text className="graph-label" x={x + 10} y={y + 19}>
                    {shortName(neighbor.name, 20)}
                  </text>
                  <text className="graph-export" x={x + 10} y={y + 34}>
                    {edge.exports?.join(", ") || edge.dependencyType || "module edge"}
                  </text>
                </a>
              );
            })}
            {!props.loading && references && visibleEdges.length === 0 ? (
              <text className="graph-empty-label" x="260" y="232" textAnchor="middle">
                {emptyDirectionLabel(props.direction)}
              </text>
            ) : null}
          </svg>
        ) : (
          <div className="reference-empty">No module instance is available for this export.</div>
        )}
      </div>
      {displayedEdges.length ? (
        <div className="reference-list">
          {displayedEdges.map((edge) => {
            const neighbor = edgeNeighbor(edge, selectedModuleId);
            const incoming = edge.targetId === selectedModuleId;
            return (
              <button
                type="button"
                className={edgeMatchesExport(edge) ? "is-export-edge" : undefined}
                key={edge.id}
                onClick={() => props.onSelectEdge(edge.id)}
              >
                <span>{incoming ? "← importer" : "→ dependency"}</span>
                <strong title={neighbor.identifier}>{shortName(neighbor.name, 38)}</strong>
                <small>
                  {edge.exports?.join(", ") || edge.request || edge.dependencyType || "module"}
                </small>
              </button>
            );
          })}
        </div>
      ) : null}
      {references?.nextCursor !== null && references?.nextCursor !== undefined ? (
        <button className="load-more-references" type="button" onClick={props.onLoadMore}>
          Load more references
        </button>
      ) : null}
      <SnippetCard
        snippet={props.snippet}
        flashKey={props.snippetFlashKey}
        onClose={props.onCloseSnippet}
      />
    </aside>
  );
}

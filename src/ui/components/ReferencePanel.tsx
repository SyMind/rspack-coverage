import { useEffect, useRef } from "react";
import type {
  CodeCoverageState,
  ModuleReferencesResponse,
  ReferenceEdgeReport,
  ReferenceSnippetResponse,
} from "../../shared/types.js";
import { formatPercent } from "../lib/format.js";

const STATUS_LABELS: Record<CodeCoverageState, string> = {
  executed: "Executed",
  unexecuted: "Loaded / unexecuted",
  "not-emitted": "Not emitted",
  unloaded: "Not loaded",
  unknown: "Unknown",
  neutral: "No coverage evidence",
};

function shortName(value: string, maximum = 31): string {
  const name = value.split(/[\\/]/).at(-1) ?? value;
  return name.length > maximum ? `${name.slice(0, maximum - 1)}…` : name;
}

function edgeNeighbor(edge: ReferenceEdgeReport, selectedId: string) {
  return edge.originId === selectedId ? edge.target : edge.origin;
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
    ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [props.snippet, props.flashKey]);
  if (!props.snippet) return null;
  const snippet = props.snippet;
  const status = snippet.highlight?.coverageStatus ?? "unknown";
  const content = snippet.content ?? "";
  const start = Math.max(0, Math.min(content.length, snippet.highlight?.start ?? 0));
  const end = Math.max(start, Math.min(content.length, snippet.highlight?.end ?? start));
  return (
    <div className="reference-snippet" ref={ref}>
      <header>
        <div>
          <span>Usage location</span>
          <strong title={snippet.filename}>{snippet.filename ?? "Unavailable"}</strong>
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
              Module usage {formatPercent(snippet.coverage?.usageRatio ?? null)} · lines{" "}
              {snippet.startLine}–{snippet.endLine}
            </span>
          </div>
          <pre>
            {content.slice(0, start)}
            <mark className={`usage-highlight coverage-${status}`} key={props.flashKey}>
              {content.slice(start, end) || " "}
            </mark>
            {content.slice(end)}
          </pre>
        </>
      ) : (
        <p>{snippet.gap}</p>
      )}
    </div>
  );
}

export function ReferencePanel(props: {
  references: ModuleReferencesResponse | null;
  direction: "in" | "out" | "both";
  loading: boolean;
  snippet: ReferenceSnippetResponse | null;
  snippetFlashKey: number;
  onDirectionChange: (direction: "in" | "out" | "both") => void;
  onSelectEdge: (edgeId: string) => void;
  onLoadMore: () => void;
  onClose?: () => void;
  onCloseSnippet: () => void;
}) {
  const references = props.references;
  const visibleEdges = references?.edges.slice(0, 12) ?? [];
  return (
    <aside className="reference-workbench" aria-label="Module reference graph">
      <div className="reference-toolbar">
        <div>
          <span className="eyebrow">Compilation references</span>
          <h3>Module reference chain</h3>
        </div>
        <div className="reference-toolbar-actions">
          <span className="reference-count">{references?.total.toLocaleString() ?? "—"}</span>
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
      <fieldset className="segmented reference-direction">
        <legend className="sr-only">Reference direction</legend>
        {(["in", "both", "out"] as const).map((direction) => (
          <button
            type="button"
            className={props.direction === direction ? "active" : ""}
            key={direction}
            onClick={() => props.onDirectionChange(direction)}
          >
            {direction === "in" ? "Consumers" : direction === "out" ? "Dependencies" : "All"}
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
        {!props.loading && visibleEdges.length === 0 ? (
          <div className="reference-empty">
            No direct reference edge was captured for this module.
          </div>
        ) : null}
        {references && visibleEdges.length ? (
          <svg className="reference-graph" viewBox="0 0 520 330" role="img">
            <title>Direct consumers and dependencies</title>
            <rect className="graph-center" x="170" y="135" width="180" height="58" rx="10" />
            <text className="graph-label graph-label-center" x="260" y="168" textAnchor="middle">
              {shortName(references.module.name, 27)}
            </text>
            {visibleEdges.map((edge) => {
              const incoming = edge.targetId === references.module.id;
              const sideEdges = visibleEdges.filter(
                (candidate) => (candidate.targetId === references.module.id) === incoming,
              );
              const sideIndex = sideEdges.findIndex((candidate) => candidate.id === edge.id);
              const x = incoming ? 8 : 372;
              const y = 18 + sideIndex * Math.min(62, 285 / Math.max(1, sideEdges.length));
              const lineStartX = incoming ? x + 140 : 350;
              const lineEndX = incoming ? 170 : x;
              const lineY = y + 22;
              const neighbor = edgeNeighbor(edge, references.module.id);
              return (
                <a
                  className="graph-node"
                  key={edge.id}
                  href={`#reference-${edge.id}`}
                  aria-label={`Show usage ${neighbor.name}`}
                  onClick={(event) => {
                    event.preventDefault();
                    props.onSelectEdge(edge.id);
                  }}
                >
                  <line className="graph-edge" x1={lineStartX} y1={lineY} x2={lineEndX} y2="164" />
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
          </svg>
        ) : null}
      </div>
      {references?.edges.length ? (
        <div className="reference-list">
          {references.edges.map((edge) => {
            const neighbor = edgeNeighbor(edge, references.module.id);
            const incoming = edge.targetId === references.module.id;
            return (
              <button type="button" key={edge.id} onClick={() => props.onSelectEdge(edge.id)}>
                <span>{incoming ? "← consumer" : "→ dependency"}</span>
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

import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { sourceLineCoverageStatus } from "../../shared/codeCoverage.js";
import { metricsForModuleInstance } from "../../shared/metrics.js";
import type {
  BuildModule,
  CodeCoverageState,
  ModuleReferencesResponse,
  ReferenceSnippetResponse,
  SourceExportAnalysisStatus,
  SourceExportUsage,
  SourceFileDetail,
  SourceFileSummary,
  SourceLineState,
} from "../../shared/types.js";
import {
  loadCoverageSource,
  loadReferenceSnippet,
  loadReferences,
  loadSourceExportStatus,
} from "../lib/api.js";
import { formatBytes, formatPercent } from "../lib/format.js";
import { SyntaxText } from "./CoverageCode.js";
import { ReferencePanel } from "./ReferencePanel.js";

function buildLabel(line: SourceLineState): string {
  if (line.buildState === "not-emitted") return "Removed from final generated output";
  if (line.buildState === "unknown") return "Build state unavailable";
  if (line.runtimeState === "not-loaded") return "Retained, but its chunk was not loaded";
  if (line.runtimeState === "not-executed") return "Retained and loaded, but not executed";
  return "Executed mapped ranges";
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timeout);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function useExportAnalysis(buildHash: string, file: SourceFileSummary | null, retry: number) {
  const [status, setStatus] = useState<SourceExportAnalysisStatus | null>(null);
  useEffect(() => {
    setStatus(null);
    if (!file) return;
    const controller = new AbortController();
    void (async () => {
      try {
        while (!controller.signal.aborted) {
          const next = await loadSourceExportStatus(buildHash, file.path, controller.signal, retry);
          setStatus(next);
          if (next.status !== "pending") return;
          await wait(150, controller.signal);
        }
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          setStatus({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    return () => controller.abort();
  }, [buildHash, file, retry]);
  return status;
}

type SourceDetailStatus =
  | { status: "loading" }
  | { status: "complete"; detail: SourceFileDetail }
  | { status: "error"; message: string };

function useSourceDetail(
  buildHash: string,
  file: SourceFileSummary | null,
  moduleId: string | null,
  retry: number,
) {
  const [status, setStatus] = useState<SourceDetailStatus | null>(null);
  useEffect(() => {
    setStatus(file ? { status: "loading" } : null);
    if (!file) return;
    const controller = new AbortController();
    void loadCoverageSource(buildHash, file.id, controller.signal, retry, moduleId)
      .then((detail) => {
        if (detail.id !== file.id)
          throw new Error("Coverage source detail does not match the file.");
        if (!controller.signal.aborted) setStatus({ status: "complete", detail });
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError") {
          setStatus({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => controller.abort();
  }, [buildHash, file, moduleId, retry]);
  return status;
}

function ExportStatus(props: { status: SourceExportAnalysisStatus | null; onRetry: () => void }) {
  if (!props.status || props.status.status === "pending") {
    const pending = props.status?.status === "pending" ? props.status : null;
    return (
      <div className="export-analysis-status is-loading" aria-live="polite">
        <span className="spinner" />
        <span>
          <b>Export analysis</b>
          <small>
            {pending?.phase ?? "Starting"}
            {pending && pending.total > 1 ? ` · ${pending.completed}/${pending.total}` : ""}
          </small>
        </span>
      </div>
    );
  }
  if (props.status.status === "error") {
    return (
      <div className="export-analysis-status is-error" role="status">
        <span>
          <b>Export analysis unavailable</b>
          <small>{props.status.message}</small>
        </span>
        <button type="button" onClick={props.onRetry}>
          Retry
        </button>
      </div>
    );
  }
  const { summary, diagnostics } = props.status.report;
  return (
    <div className={`export-analysis-status ${diagnostics.length ? "is-limited" : "is-ready"}`}>
      <span>
        <b>Export analysis</b>
        <small>
          {summary.total} exports · {summary.used} used · {summary.unused} unused ·{" "}
          {summary.unknown} unknown
        </small>
      </span>
      {diagnostics[0] ? <em title={diagnostics.join("\n")}>{diagnostics[0]}</em> : null}
    </div>
  );
}

function SourceCode(props: {
  text: string;
  status: CodeCoverageState;
  markers: SourceExportUsage[];
  onMarkerClick: (usage: SourceExportUsage) => void;
  activeExportId: string | null;
}) {
  const text = props.text || " ";
  const coverageClass = `coverage-segment coverage-${props.status}`;
  if (props.markers.length === 0) {
    return (
      <code>
        <span className={coverageClass}>
          <SyntaxText text={text} keyPrefix="source" />
        </span>
      </code>
    );
  }
  const pieces: ReactNode[] = [];
  let cursor = 0;
  for (const marker of props.markers) {
    const start = Math.min(text.length, Math.max(cursor, marker.range.start.column));
    const end = Math.min(text.length, Math.max(start, marker.range.end.column));
    if (end <= start) continue;
    if (start > cursor) {
      pieces.push(
        <SyntaxText
          text={text.slice(cursor, start)}
          keyPrefix={`source:${cursor}:${start}`}
          key={`text:${cursor}:${start}`}
        />,
      );
    }
    const selected = props.activeExportId === marker.id;
    pieces.push(
      <button
        type="button"
        className={`export-marker state-${marker.state} precision-${marker.precision} ${selected ? "is-active" : ""}`}
        key={marker.id}
        title={`Open importers and module graph for export ${marker.exportedName}`}
        onClick={() => props.onMarkerClick(marker)}
      >
        <SyntaxText text={text.slice(start, end)} keyPrefix={`export:${marker.id}`} />
      </button>,
    );
    cursor = end;
  }
  if (cursor < text.length) {
    pieces.push(
      <SyntaxText
        text={text.slice(cursor)}
        keyPrefix={`source:${cursor}:${text.length}`}
        key={`text:${cursor}:${text.length}`}
      />,
    );
  }
  return (
    <code>
      <span className={coverageClass}>{pieces}</span>
    </code>
  );
}

function preferredModuleInstance(usage: SourceExportUsage) {
  return (
    usage.moduleInstances.find(
      (candidate) => candidate.state === "used" && candidate.chunks.length > 0,
    ) ??
    usage.moduleInstances.find((candidate) => candidate.chunks.length > 0) ??
    usage.moduleInstances.find((candidate) => candidate.state === "used") ??
    usage.moduleInstances[0] ??
    null
  );
}

export function SourceDrawer(props: {
  buildHash: string;
  file: SourceFileSummary | null;
  moduleId: string | null;
  module?: BuildModule | null;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [retry, setRetry] = useState(0);
  const [detailRetry, setDetailRetry] = useState(0);
  const [activeExportId, setActiveExportId] = useState<string | null>(null);
  const [moduleId, setModuleId] = useState<string | null>(null);
  const [direction, setDirection] = useState<"in" | "out" | "both">("in");
  const [references, setReferences] = useState<ModuleReferencesResponse | null>(null);
  const [snippet, setSnippet] = useState<ReferenceSnippetResponse | null>(null);
  const [snippetFlashKey, setSnippetFlashKey] = useState(0);
  const [loadingReferences, setLoadingReferences] = useState(false);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const analysis = useExportAnalysis(props.buildHash, props.file, retry);
  const detailStatus = useSourceDetail(props.buildHash, props.file, props.moduleId, detailRetry);
  const report = analysis?.status === "complete" ? analysis.report : null;
  const rawLines = detailStatus?.status === "complete" ? detailStatus.detail.lines : [];
  const selectedModuleLoaded =
    !props.module?.chunks.length ||
    Boolean(
      props.file && props.module.chunks.some((chunk) => props.file?.loadedChunks.includes(chunk)),
    );
  const lines = useMemo(
    () =>
      selectedModuleLoaded
        ? rawLines
        : rawLines.map((line) =>
            line.buildState !== "retained"
              ? line
              : {
                  ...line,
                  runtimeState: "not-loaded" as const,
                  loadedBytes: 0,
                  executedBytes: 0,
                  ranges: line.ranges.map((range) => ({ ...range, executed: false })),
                },
          ),
    [rawLines, selectedModuleLoaded],
  );
  const markerLines = useMemo(() => {
    const result = new Map<number, SourceExportUsage[]>();
    for (const item of report?.exports ?? []) {
      if (item.moduleInstances.length === 0) continue;
      if (item.range.start.line !== item.range.end.line) continue;
      const list = result.get(item.range.start.line) ?? [];
      list.push(item);
      result.set(item.range.start.line, list);
    }
    for (const list of result.values()) {
      list.sort((left, right) => left.range.start.column - right.range.start.column);
    }
    return result;
  }, [report]);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 24,
    overscan: 30,
  });
  useEffect(() => {
    if (!moduleId) return;
    let cancelled = false;
    setLoadingReferences(true);
    setReferenceError(null);
    setSnippet(null);
    void loadReferences(moduleId, direction)
      .then((next) => {
        if (!cancelled) setReferences(next);
      })
      .catch((error) => {
        if (!cancelled) {
          setReferences(null);
          setReferenceError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingReferences(false);
      });
    return () => {
      cancelled = true;
    };
  }, [moduleId, direction]);

  const openDependencyGraph = (usage: SourceExportUsage) => {
    const instance =
      usage.moduleInstances.find((candidate) => candidate.moduleId === props.moduleId) ??
      preferredModuleInstance(usage);
    if (!instance) return;
    setActiveExportId(usage.id);
    setModuleId(instance.moduleId);
    setDirection("in");
    setReferences(null);
    setSnippet(null);
    setReferenceError(null);
    const url = new URL(location.href);
    url.searchParams.set("module", instance.moduleId);
    url.searchParams.set("export", usage.exportedName);
    history.replaceState(null, "", url);
  };
  const closeDependencyGraph = () => {
    setModuleId(null);
    setActiveExportId(null);
    setReferences(null);
    setSnippet(null);
    setLoadingReferences(false);
    setReferenceError(null);
    const url = new URL(location.href);
    url.searchParams.delete("module");
    url.searchParams.delete("export");
    history.replaceState(null, "", url);
  };
  if (!props.file) return null;
  const file = props.file;
  const metrics = props.moduleId ? metricsForModuleInstance(file, props.module) : file.metrics;
  const activeExport = report?.exports.find((candidate) => candidate.id === activeExportId) ?? null;
  const activeModuleInstance =
    activeExport?.moduleInstances.find((candidate) => candidate.moduleId === moduleId) ?? null;
  return (
    <div className="drawer-backdrop">
      <aside
        className="source-drawer coverage-source-drawer"
        aria-label={`Source details for ${file.path}`}
      >
        <header>
          <h2 title={file.path}>{file.path.split("/").at(-1)}</h2>
          <button
            type="button"
            className="close-button"
            onClick={props.onClose}
            aria-label="Close source details"
          >
            ×
          </button>
        </header>
        <ExportStatus status={analysis} onRetry={() => setRetry((value) => value + 1)} />
        <div className="drawer-metrics">
          <span>
            <small>Loaded</small>
            {formatBytes(metrics.loadedBytes)}
          </span>
          <span>
            <small>Executed</small>
            {formatBytes(metrics.executedBytes)}
          </span>
          <span>
            <small>{props.moduleId ? "Unused" : "Unexecuted"}</small>
            {formatBytes(metrics.unusedBytes)}
          </span>
          <span>
            <small>Usage</small>
            {formatPercent(metrics.usageRatio)}
          </span>
          <span>
            <small>{props.moduleId ? "Retained" : "Mapped"}</small>
            {props.moduleId
              ? formatBytes(metrics.emittedBytes)
              : formatPercent(
                  metrics.emittedBytes ? metrics.mappedBytes / metrics.emittedBytes : null,
                )}
          </span>
        </div>
        <div className="source-legend">
          <span>
            <i className="swatch executed" /> executed
          </span>
          <span>
            <i className="swatch unused" />
            {props.moduleId ? "retained + loaded, not executed" : "loaded / unexecuted"}
          </span>
          <span>
            <i className="swatch not-loaded" /> not loaded
          </span>
          <span>
            <i className="swatch not-emitted" /> not emitted
          </span>
          <span>
            <i className="swatch export-used" /> clickable export
          </span>
        </div>
        <div className="source-code-panel">
          <div className="source-columns">
            <span>Line</span>
            <span>Source</span>
          </div>
          <div className="source-scroll" ref={scrollRef}>
            {detailStatus?.status === "loading" ? (
              <div className="source-detail-status" aria-live="polite">
                <span className="spinner" /> Loading source details from Node…
              </div>
            ) : detailStatus?.status === "error" ? (
              <div className="source-detail-status is-error" role="status">
                <span>{detailStatus.message}</span>
                <button type="button" onClick={() => setDetailRetry((value) => value + 1)}>
                  Retry
                </button>
              </div>
            ) : null}
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
                    <span className="line-number">{line.line}</span>
                    <SourceCode
                      text={line.text || " "}
                      status={sourceLineCoverageStatus(line)}
                      markers={markerLines.get(line.line) ?? []}
                      onMarkerClick={openDependencyGraph}
                      activeExportId={activeExportId}
                    />
                  </div>
                );
              })}
            </div>
          </div>
          {moduleId ? (
            <div className="export-dependency-graph">
              <ReferencePanel
                exportUsage={activeExport}
                moduleInstance={activeModuleInstance}
                references={references}
                direction={direction}
                loading={loadingReferences}
                error={referenceError}
                snippet={snippet}
                snippetFlashKey={snippetFlashKey}
                onDirectionChange={(nextDirection) => {
                  if (nextDirection === direction) return;
                  setDirection(nextDirection);
                  setReferences((current) =>
                    current
                      ? {
                          ...current,
                          direction: nextDirection,
                          total: current.counts[nextDirection],
                          cursor: 0,
                          nextCursor: null,
                          edges: [],
                        }
                      : null,
                  );
                  setSnippet(null);
                  setReferenceError(null);
                }}
                onSelectEdge={(edgeId) => {
                  void loadReferenceSnippet(edgeId).then((next) => {
                    setSnippet(next);
                    setSnippetFlashKey((value) => value + 1);
                  });
                }}
                onLoadMore={() => {
                  if (references?.nextCursor === null || references?.nextCursor === undefined)
                    return;
                  void loadReferences(moduleId, direction, references.nextCursor).then((next) =>
                    setReferences({ ...next, edges: [...references.edges, ...next.edges] }),
                  );
                }}
                onModuleChange={(nextModuleId) => {
                  setModuleId(nextModuleId);
                  setDirection("in");
                  setReferences(null);
                  setSnippet(null);
                  setReferenceError(null);
                  const url = new URL(location.href);
                  url.searchParams.set("module", nextModuleId);
                  history.replaceState(null, "", url);
                }}
                onClose={closeDependencyGraph}
                onCloseSnippet={() => setSnippet(null)}
              />
            </div>
          ) : null}
        </div>
        <footer>
          Module sizes count retained original-source UTF-8 bytes once, so generated/minified output
          cannot inflate this module. Unused excludes source lines removed from the final build and
          code in chunks that were not loaded. Exports with a captured module instance are
          clickable. The importer chain and module graph retain separate usage evidence; green and
          red remain runtime Coverage states.
        </footer>
      </aside>
    </div>
  );
}

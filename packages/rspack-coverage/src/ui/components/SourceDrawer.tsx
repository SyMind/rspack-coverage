import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { sourceLineCoverageStatus } from "../../shared/codeCoverage.js";
import { metricsForModuleInstance } from "../../shared/metrics.js";
import type {
  BuildModule,
  CodeCoverageState,
  CodeViewResponse,
  ExportImporterChainResponse,
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
  loadExportDeclaration,
  loadExportImporterChain,
  loadGeneratedSource,
  loadReferenceSnippet,
  loadReferences,
  loadSourceExportStatus,
  openInEditor,
} from "../lib/api.js";
import { copyablePathProps } from "../lib/copyFullPath.js";
import { formatBytes, formatPercent } from "../lib/format.js";
import { CoverageCode, SyntaxText } from "./CoverageCode.js";
import { ReferencePanel } from "./ReferencePanel.js";

const GENERATED_CODE_PAGE = 240_000;
const UNMAPPED_SOURCE_PREFIX = "[rspack runtime / unmapped]/";
const SOURCE_EXPORT_INLINE_LIMIT = 4;

function exportStateLabel(usage: SourceExportUsage): string {
  switch (usage.state) {
    case "used":
      return "used";
    case "unused":
      return "unused";
    case "type-only":
      return "type only";
    default:
      return "unknown";
  }
}

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

type GeneratedSourceStatus =
  | { status: "loading" }
  | { status: "complete"; code: CodeViewResponse }
  | { status: "error"; message: string };

function useGeneratedSource(
  buildHash: string,
  file: SourceFileSummary | null,
  offset: number,
  retry: number,
) {
  const [status, setStatus] = useState<GeneratedSourceStatus | null>(null);
  useEffect(() => {
    setStatus(file ? { status: "loading" } : null);
    if (!file) return;
    const controller = new AbortController();
    void loadGeneratedSource(
      buildHash,
      file.id,
      offset,
      GENERATED_CODE_PAGE,
      controller.signal,
      retry,
    )
      .then((code) => {
        if (!controller.signal.aborted) setStatus({ status: "complete", code });
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
  }, [buildHash, file, offset, retry]);
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

interface SourceSearchMatch {
  index: number;
  row: number;
  line: number;
  start: number;
  end: number;
}

const MAX_SOURCE_SEARCH_MATCHES = 20_000;

function findSourceSearchMatches(
  lines: SourceLineState[],
  query: string,
): { matches: SourceSearchMatch[]; truncated: boolean } {
  if (!query) return { matches: [], truncated: false };
  const needle = query.toLowerCase();
  const matches: SourceSearchMatch[] = [];
  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row];
    if (!line) continue;
    const haystack = line.text.toLowerCase();
    let cursor = 0;
    while (cursor <= haystack.length - needle.length) {
      const start = haystack.indexOf(needle, cursor);
      if (start < 0) break;
      matches.push({
        index: matches.length,
        row,
        line: line.line,
        start,
        end: start + needle.length,
      });
      if (matches.length === MAX_SOURCE_SEARCH_MATCHES) {
        return { matches, truncated: true };
      }
      cursor = start + needle.length;
    }
  }
  return { matches, truncated: false };
}

function SearchSyntaxText(props: {
  text: string;
  offset: number;
  matches: SourceSearchMatch[];
  activeMatchIndex: number;
  keyPrefix: string;
}) {
  if (props.matches.length === 0) {
    return <SyntaxText text={props.text} keyPrefix={props.keyPrefix} />;
  }
  const pieces: ReactNode[] = [];
  const sliceEnd = props.offset + props.text.length;
  let cursor = props.offset;
  for (const match of props.matches) {
    const start = Math.max(props.offset, match.start);
    const end = Math.min(sliceEnd, match.end);
    if (end <= start) continue;
    if (start > cursor) {
      pieces.push(
        <SyntaxText
          text={props.text.slice(cursor - props.offset, start - props.offset)}
          keyPrefix={`${props.keyPrefix}:${cursor}:${start}`}
          key={`text:${cursor}:${start}`}
        />,
      );
    }
    pieces.push(
      <mark
        className={`code-search-match ${match.index === props.activeMatchIndex ? "is-active" : ""}`}
        data-code-search-index={match.index}
        key={`match:${match.index}:${start}:${end}`}
      >
        <SyntaxText
          text={props.text.slice(start - props.offset, end - props.offset)}
          keyPrefix={`${props.keyPrefix}:match:${match.index}`}
        />
      </mark>,
    );
    cursor = end;
  }
  if (cursor < sliceEnd) {
    pieces.push(
      <SyntaxText
        text={props.text.slice(cursor - props.offset)}
        keyPrefix={`${props.keyPrefix}:${cursor}:${sliceEnd}`}
        key={`text:${cursor}:${sliceEnd}`}
      />,
    );
  }
  return <>{pieces}</>;
}

function SourceCode(props: {
  text: string;
  status: CodeCoverageState;
  markers: SourceExportUsage[];
  onMarkerClick: (usage: SourceExportUsage) => void;
  activeExportId: string | null;
  searchMatches: SourceSearchMatch[];
  activeSearchIndex: number;
}) {
  const text = props.text || " ";
  const coverageClass = `coverage-segment coverage-${props.status}`;
  if (props.markers.length === 0) {
    return (
      <code>
        <span className={coverageClass}>
          <SearchSyntaxText
            text={text}
            offset={0}
            matches={props.searchMatches}
            activeMatchIndex={props.activeSearchIndex}
            keyPrefix="source"
          />
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
        <SearchSyntaxText
          text={text.slice(cursor, start)}
          offset={cursor}
          matches={props.searchMatches}
          activeMatchIndex={props.activeSearchIndex}
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
        <SearchSyntaxText
          text={text.slice(start, end)}
          offset={start}
          matches={props.searchMatches}
          activeMatchIndex={props.activeSearchIndex}
          keyPrefix={`export:${marker.id}`}
        />
      </button>,
    );
    cursor = end;
  }
  if (cursor < text.length) {
    pieces.push(
      <SearchSyntaxText
        text={text.slice(cursor)}
        offset={cursor}
        matches={props.searchMatches}
        activeMatchIndex={props.activeSearchIndex}
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
  initialExportName?: string | null;
  restoreFromUrl?: boolean;
  module?: BuildModule | null;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [retry, setRetry] = useState(0);
  const [detailRetry, setDetailRetry] = useState(0);
  const [generatedRetry, setGeneratedRetry] = useState(0);
  const [generatedOffset, setGeneratedOffset] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const [wrapLines, setWrapLines] = useState(false);
  const [activeExportId, setActiveExportId] = useState<string | null>(null);
  const [moduleId, setModuleId] = useState<string | null>(null);
  const [direction, setDirection] = useState<"in" | "out" | "both">("in");
  const [moduleGraphDepth, setModuleGraphDepth] = useState(4);
  const [references, setReferences] = useState<ModuleReferencesResponse | null>(null);
  const [importerChain, setImporterChain] = useState<ExportImporterChainResponse | null>(null);
  const [snippet, setSnippet] = useState<ReferenceSnippetResponse | null>(null);
  const [snippetFlashKey, setSnippetFlashKey] = useState(0);
  const snippetRequestRef = useRef(0);
  const [loadingReferences, setLoadingReferences] = useState(false);
  const [loadingImporterChain, setLoadingImporterChain] = useState(false);
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [importerChainError, setImporterChainError] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const generatedFallback = Boolean(
    props.file && !props.moduleId && props.file.path.startsWith(UNMAPPED_SOURCE_PREFIX),
  );
  const analysis = useExportAnalysis(props.buildHash, generatedFallback ? null : props.file, retry);
  const detailStatus = useSourceDetail(
    props.buildHash,
    generatedFallback ? null : props.file,
    props.moduleId,
    detailRetry,
  );
  const generatedStatus = useGeneratedSource(
    props.buildHash,
    generatedFallback ? props.file : null,
    generatedOffset,
    generatedRetry,
  );
  const report = analysis?.status === "complete" ? analysis.report : null;
  const sourceModuleId = props.moduleId ?? props.file?.moduleIds[0] ?? null;
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
  const sourceSearch = useMemo(
    () => findSourceSearchMatches(lines, searchQuery),
    [lines, searchQuery],
  );
  const activeSearchIndex = sourceSearch.matches.length
    ? Math.min(searchIndex, sourceSearch.matches.length - 1)
    : -1;
  const activeSearchMatch = sourceSearch.matches[activeSearchIndex] ?? null;
  const searchMatchesByLine = useMemo(() => {
    const result = new Map<number, SourceSearchMatch[]>();
    for (const match of sourceSearch.matches) {
      const matches = result.get(match.line) ?? [];
      matches.push(match);
      result.set(match.line, matches);
    }
    return result;
  }, [sourceSearch.matches]);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 24,
    overscan: 30,
  });
  useEffect(() => {
    if (wrapLines && scrollRef.current) scrollRef.current.scrollLeft = 0;
    virtualizer.measure?.();
  }, [virtualizer, wrapLines]);
  useEffect(() => {
    if (!props.file?.id) return;
    setSearchQuery("");
    setSearchIndex(0);
    setGeneratedOffset(0);
    setEditorError(null);
  }, [props.file?.id]);
  useEffect(() => {
    if (!activeSearchMatch) return;
    virtualizer.scrollToIndex?.(activeSearchMatch.row, { align: "center" });
  }, [activeSearchMatch, virtualizer]);
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (moduleId || (!event.metaKey && !event.ctrlKey) || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [moduleId]);
  const moveSearch = (delta: number) => {
    if (sourceSearch.matches.length === 0) return;
    setSearchIndex((current) => {
      const normalized = Math.min(Math.max(current, 0), sourceSearch.matches.length - 1);
      return (normalized + delta + sourceSearch.matches.length) % sourceSearch.matches.length;
    });
  };
  useEffect(() => {
    if (!moduleId) return;
    let cancelled = false;
    setLoadingReferences(true);
    setReferenceError(null);
    setSnippet(null);
    const request =
      moduleGraphDepth === 4
        ? loadReferences(moduleId, direction)
        : loadReferences(moduleId, direction, 0, 80, moduleGraphDepth);
    void request
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
  }, [moduleId, direction, moduleGraphDepth]);

  useEffect(() => {
    const selectedExport = report?.exports.find((candidate) => candidate.id === activeExportId);
    setImporterChain(null);
    setImporterChainError(null);
    setLoadingImporterChain(Boolean(moduleId && selectedExport));
    if (!moduleId || !selectedExport) return;
    let cancelled = false;
    const snippetRequest = ++snippetRequestRef.current;
    setSnippet(null);
    void loadExportDeclaration(moduleId, selectedExport.exportedName)
      .then((next) => {
        if (!cancelled && snippetRequestRef.current === snippetRequest) {
          setSnippet(next);
          setSnippetFlashKey((value) => value + 1);
        }
      })
      .catch(() => undefined);
    void loadExportImporterChain(moduleId, selectedExport.exportedName)
      .then((next) => {
        if (!cancelled) setImporterChain(next);
      })
      .catch((error) => {
        if (!cancelled) {
          setImporterChainError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingImporterChain(false);
      });
    return () => {
      cancelled = true;
    };
  }, [moduleId, activeExportId, report]);

  useEffect(() => {
    if (!props.restoreFromUrl || !props.moduleId) return;
    const requestedExportName = props.initialExportName?.trim() ?? "";
    if (requestedExportName && !report) return;
    const requestedExport = requestedExportName
      ? (report?.exports.find(
          (candidate) =>
            candidate.exportedName === requestedExportName &&
            candidate.moduleInstances.some((instance) => instance.moduleId === props.moduleId),
        ) ?? null)
      : null;
    snippetRequestRef.current += 1;
    setModuleId(props.moduleId);
    setActiveExportId(requestedExport?.id ?? null);
    setDirection("in");
    setModuleGraphDepth(4);
    setReferences(null);
    setImporterChain(null);
    setSnippet(null);
    setReferenceError(null);
    setImporterChainError(
      requestedExportName && !requestedExport
        ? `Export ${requestedExportName} is unavailable for this module instance.`
        : null,
    );
  }, [props.moduleId, props.initialExportName, props.restoreFromUrl, report]);

  const openDependencyGraph = (usage: SourceExportUsage) => {
    const instance =
      usage.moduleInstances.find((candidate) => candidate.moduleId === sourceModuleId) ??
      preferredModuleInstance(usage);
    if (!instance) return;
    setActiveExportId(usage.id);
    setModuleId(instance.moduleId);
    setDirection("in");
    setModuleGraphDepth(4);
    setReferences(null);
    setImporterChain(null);
    setSnippet(null);
    snippetRequestRef.current += 1;
    setReferenceError(null);
    setImporterChainError(null);
    const url = new URL(location.href);
    url.searchParams.set("module", instance.moduleId);
    url.searchParams.set("export", usage.exportedName);
    history.replaceState(null, "", url);
  };
  const openModuleGraph = () => {
    if (!sourceModuleId) return;
    snippetRequestRef.current += 1;
    setActiveExportId(null);
    setModuleId(sourceModuleId);
    setDirection("in");
    setModuleGraphDepth(4);
    setReferences(null);
    setImporterChain(null);
    setSnippet(null);
    setLoadingImporterChain(false);
    setReferenceError(null);
    setImporterChainError(null);
    const url = new URL(location.href);
    url.searchParams.set("module", sourceModuleId);
    url.searchParams.delete("export");
    history.replaceState(null, "", url);
  };
  const closeDependencyGraph = () => {
    snippetRequestRef.current += 1;
    setModuleId(null);
    setActiveExportId(null);
    setModuleGraphDepth(4);
    setReferences(null);
    setImporterChain(null);
    setSnippet(null);
    setLoadingReferences(false);
    setLoadingImporterChain(false);
    setReferenceError(null);
    setImporterChainError(null);
    const url = new URL(location.href);
    url.searchParams.delete("module");
    url.searchParams.delete("export");
    history.replaceState(null, "", url);
  };
  if (!props.file) return null;
  const file = props.file;
  const editorModuleId = sourceModuleId;
  const metrics = props.moduleId ? metricsForModuleInstance(file, props.module) : file.metrics;
  const generatedCode = generatedStatus?.status === "complete" ? generatedStatus.code : null;
  const moduleExports = (report?.exports ?? []).filter((usage) =>
    usage.moduleInstances.some((instance) => instance.moduleId === editorModuleId),
  );
  const activeExport = report?.exports.find((candidate) => candidate.id === activeExportId) ?? null;
  const activeModuleInstance =
    activeExport?.moduleInstances.find((candidate) => candidate.moduleId === moduleId) ?? null;
  return (
    <div className="drawer-backdrop">
      <button
        type="button"
        className="drawer-backdrop-dismiss"
        aria-label="Dismiss source details"
        onClick={props.onClose}
      />
      <aside
        className="source-drawer coverage-source-drawer"
        aria-label={`Source details for ${file.path}`}
      >
        <header>
          <div className="source-title">
            <h2>
              {editorModuleId ? (
                <button
                  type="button"
                  className="source-path-button"
                  {...copyablePathProps(file.path)}
                  aria-label={`Open ${file.path} in VS Code`}
                  onClick={() => {
                    setEditorError(null);
                    void openInEditor({
                      moduleId: editorModuleId,
                      sourceId: file.id,
                      line: 1,
                      column: 1,
                    })
                      .then((result) => {
                        if (!result.opened) {
                          setEditorError("VS Code could not be opened on this machine.");
                        }
                      })
                      .catch((error) => {
                        setEditorError(error instanceof Error ? error.message : String(error));
                      });
                  }}
                >
                  <span>{file.path}</span>
                  <span className="source-path-icon" aria-hidden="true">
                    ↗
                  </span>
                </button>
              ) : (
                <span className="source-path-static" {...copyablePathProps(file.path)}>
                  {file.path}
                </span>
              )}
            </h2>
            {editorError ? (
              <span className="source-editor-error" role="status">
                {editorError}
              </span>
            ) : null}
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
        {generatedFallback ? (
          <div className="export-analysis-status is-ready generated-fallback-status">
            <span>
              <b>Generated output fallback</b>
              <small>Final asset context for bytes without stable source-map attribution</small>
            </span>
          </div>
        ) : (
          <ExportStatus status={analysis} onRetry={() => setRetry((value) => value + 1)} />
        )}
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
        {generatedFallback ? (
          <div className="source-legend">
            <span>
              <i className="swatch executed" /> executed unmapped output
            </span>
            <span>
              <i className="swatch unused" /> loaded / unexecuted unmapped output
            </span>
            <span>
              <i className="swatch generated-unloaded" /> not loaded
            </span>
            <span>
              <i className="swatch generated-unknown" /> recording unavailable
            </span>
            <span>
              <i className="swatch neutral" /> mapped source context
            </span>
          </div>
        ) : (
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
        )}
        <div className="source-code-panel">
          {generatedFallback ? (
            <>
              <div className="code-toolbar generated-code-toolbar">
                <div className="code-provenance">
                  {generatedCode ? (
                    <strong {...copyablePathProps(generatedCode.filename)}>
                      {generatedCode.filename}
                    </strong>
                  ) : (
                    <strong>Loading generated asset…</strong>
                  )}
                  <small>{generatedCode?.provenance ?? "final generated asset"}</small>
                </div>
                {generatedCode && (generatedCode.hasPrevious || generatedCode.hasNext) ? (
                  <div className="code-pager">
                    <button
                      type="button"
                      aria-label="Previous generated code page"
                      disabled={!generatedCode.hasPrevious}
                      onClick={() =>
                        setGeneratedOffset(Math.max(0, generatedCode.offset - GENERATED_CODE_PAGE))
                      }
                    >
                      Previous
                    </button>
                    <span>
                      {generatedCode.offset.toLocaleString()}–
                      {generatedCode.endOffset.toLocaleString()} /{" "}
                      {generatedCode.totalCharacters.toLocaleString()}
                    </span>
                    <button
                      type="button"
                      aria-label="Next generated code page"
                      disabled={!generatedCode.hasNext}
                      onClick={() => setGeneratedOffset(generatedCode.endOffset)}
                    >
                      Next
                    </button>
                  </div>
                ) : null}
              </div>
              {generatedCode?.gap ? (
                <div className="mapping-notice">{generatedCode.gap}</div>
              ) : null}
              <div className="coverage-code-scroll generated-code-scroll">
                {generatedStatus?.status === "loading" ? (
                  <div className="source-detail-status" aria-live="polite">
                    <span className="spinner" /> Loading generated asset from Node…
                  </div>
                ) : generatedStatus?.status === "error" ? (
                  <div className="source-detail-status is-error" role="status">
                    <span>{generatedStatus.message}</span>
                    <button type="button" onClick={() => setGeneratedRetry((value) => value + 1)}>
                      Retry
                    </button>
                  </div>
                ) : generatedCode ? (
                  <CoverageCode code={generatedCode} />
                ) : null}
              </div>
            </>
          ) : (
            <>
              <div className="source-columns source-code-toolbar">
                <span>Line</span>
                <span>Source</span>
                <div className="source-code-toolbar-actions">
                  {report ? (
                    moduleExports.length === 0 ? (
                      <span className="source-export-empty">0 exports</span>
                    ) : moduleExports.length <= SOURCE_EXPORT_INLINE_LIMIT ? (
                      <fieldset className="source-export-links">
                        <legend className="sr-only">Current module exports</legend>
                        <span aria-hidden="true">Exports</span>
                        {moduleExports.map((usage) => (
                          <button
                            type="button"
                            className={`source-export-link state-${usage.state}`}
                            key={usage.id}
                            title={`${usage.exportedName} · ${exportStateLabel(usage)}`}
                            aria-label={`Open export usage for ${usage.exportedName}`}
                            onClick={() => openDependencyGraph(usage)}
                          >
                            {usage.exportedName}
                          </button>
                        ))}
                      </fieldset>
                    ) : (
                      <label className="source-export-picker">
                        <span>{moduleExports.length.toLocaleString()} exports</span>
                        <select
                          aria-label="Current module export"
                          value={activeExportId ?? ""}
                          onChange={(event) => {
                            const usage = moduleExports.find(
                              (candidate) => candidate.id === event.target.value,
                            );
                            if (usage) openDependencyGraph(usage);
                          }}
                        >
                          <option value="" disabled>
                            Select export…
                          </option>
                          {moduleExports.map((usage) => (
                            <option
                              value={usage.id}
                              key={usage.id}
                              title={`${usage.exportedName} · ${exportStateLabel(usage)}`}
                            >
                              {usage.exportedName} · {exportStateLabel(usage)}
                            </option>
                          ))}
                        </select>
                      </label>
                    )
                  ) : (
                    <span className="source-export-empty">
                      {analysis?.status === "error" ? "Exports unavailable" : "Exports…"}
                    </span>
                  )}
                  <button
                    type="button"
                    className="source-module-graph-button"
                    disabled={!editorModuleId}
                    aria-label={`Open module graph for ${file.path}`}
                    title={
                      editorModuleId
                        ? `Open module graph for ${file.path}`
                        : "No captured module instance"
                    }
                    onClick={openModuleGraph}
                  >
                    Module Graph
                  </button>
                </div>
              </div>
              <search className="code-search-toolbar" aria-label="Search source code">
                <input
                  ref={searchInputRef}
                  type="search"
                  aria-label="Search source code"
                  placeholder="Search in file…"
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchQuery(event.target.value);
                    setSearchIndex(0);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      moveSearch(event.shiftKey ? -1 : 1);
                    } else if (event.key === "Escape") {
                      setSearchQuery("");
                      setSearchIndex(0);
                    }
                  }}
                />
                <span className="code-search-status" aria-live="polite">
                  {searchQuery
                    ? sourceSearch.matches.length
                      ? `${activeSearchIndex + 1} / ${sourceSearch.matches.length}${sourceSearch.truncated ? "+" : ""}`
                      : "No matches"
                    : "⌘F"}
                </span>
                <button
                  type="button"
                  aria-label="Previous search match"
                  disabled={sourceSearch.matches.length === 0}
                  onClick={() => moveSearch(-1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label="Next search match"
                  disabled={sourceSearch.matches.length === 0}
                  onClick={() => moveSearch(1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="code-wrap-toggle"
                  aria-pressed={wrapLines}
                  onClick={() => setWrapLines((current) => !current)}
                >
                  Wrap lines
                </button>
              </search>
              <div className={`source-scroll ${wrapLines ? "is-wrapped" : ""}`} ref={scrollRef}>
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
                <div
                  className="virtual-canvas"
                  style={{ height: `${virtualizer.getTotalSize()}px` }}
                >
                  {virtualizer.getVirtualItems().map((virtualRow) => {
                    const line = lines[virtualRow.index];
                    if (!line) return null;
                    return (
                      <div
                        className={`source-line build-${line.buildState} runtime-${line.runtimeState} ${activeSearchMatch?.line === line.line ? "is-search-active" : ""}`}
                        data-index={virtualRow.index}
                        key={line.line}
                        ref={virtualizer.measureElement}
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
                          searchMatches={searchMatchesByLine.get(line.line) ?? []}
                          activeSearchIndex={activeSearchIndex}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
          {moduleId ? (
            <div className="export-dependency-graph">
              <ReferencePanel
                key={activeExport?.id ?? "reference-panel"}
                exportUsage={activeExport}
                moduleInstance={activeModuleInstance}
                references={references}
                importerChain={importerChain}
                direction={direction}
                loading={loadingReferences}
                importerChainLoading={loadingImporterChain}
                error={referenceError}
                importerChainError={importerChainError}
                snippet={snippet}
                snippetFlashKey={snippetFlashKey}
                onDirectionChange={(nextDirection) => {
                  if (nextDirection === direction) return;
                  snippetRequestRef.current += 1;
                  setDirection(nextDirection);
                  setModuleGraphDepth(4);
                  setReferences((current) => {
                    if (!current) return null;
                    const { graph: _previousGraph, ...rest } = current;
                    return {
                      ...rest,
                      direction: nextDirection,
                      total: current.counts[nextDirection],
                      cursor: 0,
                      nextCursor: null,
                      edges: [],
                    };
                  });
                  setSnippet(null);
                  setReferenceError(null);
                }}
                onSelectEdge={(edgeId) => {
                  const request = ++snippetRequestRef.current;
                  void loadReferenceSnippet(edgeId).then((next) => {
                    if (snippetRequestRef.current !== request) return;
                    setSnippet(next);
                    setSnippetFlashKey((value) => value + 1);
                  });
                }}
                onSelectCarrier={(carrierModuleId, exportedName) => {
                  const request = ++snippetRequestRef.current;
                  void loadExportDeclaration(carrierModuleId, exportedName).then((next) => {
                    if (snippetRequestRef.current !== request) return;
                    setSnippet(next);
                    setSnippetFlashKey((value) => value + 1);
                  });
                }}
                onLoadMore={() => {
                  if (references?.nextCursor === null || references?.nextCursor === undefined)
                    return;
                  const request =
                    moduleGraphDepth === 4
                      ? loadReferences(moduleId, direction, references.nextCursor)
                      : loadReferences(
                          moduleId,
                          direction,
                          references.nextCursor,
                          80,
                          moduleGraphDepth,
                        );
                  void request.then((next) =>
                    setReferences({ ...next, edges: [...references.edges, ...next.edges] }),
                  );
                }}
                onLoadGraphDepth={(depth) => {
                  setModuleGraphDepth(depth);
                  setReferences(null);
                  setSnippet(null);
                  setReferenceError(null);
                }}
                onModuleChange={(nextModuleId) => {
                  snippetRequestRef.current += 1;
                  setModuleId(nextModuleId);
                  setDirection("in");
                  setModuleGraphDepth(4);
                  setReferences(null);
                  setImporterChain(null);
                  setSnippet(null);
                  setReferenceError(null);
                  setImporterChainError(null);
                  const url = new URL(location.href);
                  url.searchParams.set("module", nextModuleId);
                  history.replaceState(null, "", url);
                }}
                onClose={closeDependencyGraph}
                onCloseSnippet={() => {
                  snippetRequestRef.current += 1;
                  setSnippet(null);
                }}
              />
            </div>
          ) : null}
        </div>
        <footer>
          {generatedFallback ? (
            <>
              This synthetic file groups bytes that the final source map cannot attribute to a
              stable original source. The containing final asset is loaded on demand and paged; only
              unmapped bytes receive runtime Coverage colors, while mapped code stays neutral.
            </>
          ) : (
            <>
              Module sizes count retained original-source UTF-8 bytes once, so generated/minified
              output cannot inflate this module. Unused excludes source lines removed from the final
              build and code in chunks that were not loaded. Exports with a captured module instance
              are clickable. The importer chain and module graph retain separate usage evidence;
              green and red remain runtime Coverage states.
            </>
          )}
        </footer>
      </aside>
    </div>
  );
}

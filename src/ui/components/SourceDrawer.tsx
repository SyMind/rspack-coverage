import { useEffect, useMemo, useState } from "react";
import { sourceFileCoverageSpans } from "../../shared/codeCoverage.js";
import type {
  BuildModule,
  CodeViewResponse,
  ModuleInvestigationDetail,
  ModuleReferencesResponse,
  ReferenceSnippetResponse,
  SourceFileReport,
} from "../../shared/types.js";
import {
  loadAiContext,
  loadCode,
  loadModule,
  loadReferenceSnippet,
  loadReferences,
  loadSource,
  openInEditor,
} from "../lib/api.js";
import { formatBytes, formatPercent } from "../lib/format.js";
import { CoverageCode } from "./CoverageCode.js";
import { ReferencePanel } from "./ReferencePanel.js";

const CODE_PAGE = 240_000;

function requestedView(): "source" | "output" {
  return new URL(location.href).searchParams.get("view") === "output" ? "output" : "source";
}

function fallbackCode(file: SourceFileReport): CodeViewResponse {
  const content = file.content ?? "";
  return {
    view: "source",
    sourceId: file.id,
    filename: file.path,
    language: file.path.split(".").at(-1) ?? "javascript",
    content,
    spans: sourceFileCoverageSpans(file),
    offset: 0,
    endOffset: content.length,
    startLine: 1,
    totalCharacters: content.length,
    hasPrevious: false,
    hasNext: false,
    provenance: "captured-original-source",
    gap: "No stable Rspack module was associated with this source-map source.",
  };
}

function displayModule(module: BuildModule): string {
  return module.showFullIdentifier ? module.identifier : (module.readableIdentifier ?? module.name);
}

export function SourceDrawer(props: {
  file: SourceFileReport | null;
  modules: BuildModule[];
  onClose: () => void;
}) {
  const modulesById = useMemo(
    () => new Map(props.modules.map((module) => [module.id, module])),
    [props.modules],
  );
  const [moduleId, setModuleId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ModuleInvestigationDetail | null>(null);
  const [view, setView] = useState<"source" | "output">("source");
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [code, setCode] = useState<CodeViewResponse | null>(null);
  const [references, setReferences] = useState<ModuleReferencesResponse | null>(null);
  const [direction, setDirection] = useState<"in" | "out" | "both">("both");
  const [snippet, setSnippet] = useState<ReferenceSnippetResponse | null>(null);
  const [snippetFlashKey, setSnippetFlashKey] = useState(0);
  const [loadingCode, setLoadingCode] = useState(false);
  const [loadingReferences, setLoadingReferences] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!props.file) return;
    const url = new URL(location.href);
    const deepLinkedModule = url.searchParams.get("module");
    const initialModule =
      (deepLinkedModule && props.file.moduleIds.includes(deepLinkedModule)
        ? deepLinkedModule
        : props.file.moduleIds[0]) ?? null;
    setModuleId(initialModule);
    setDetail(null);
    setView(requestedView());
    setSourceId(url.searchParams.get("source") || props.file.id);
    setCode(null);
    setReferences(null);
    setSnippet(null);
    setDirection("both");
    setError(null);
    setNotice(null);
  }, [props.file]);

  useEffect(() => {
    if (!props.file || props.file.moduleIds.length > 0) return;
    let cancelled = false;
    void loadSource(props.file.id)
      .then((source) => {
        if (!cancelled) setCode(fallbackCode(source));
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [props.file]);

  useEffect(() => {
    if (!moduleId) return;
    let cancelled = false;
    setDetail(null);
    setCode(null);
    setReferences(null);
    setSnippet(null);
    void loadModule(moduleId)
      .then((nextDetail) => {
        if (cancelled) return;
        setDetail(nextDetail);
        const requestedSource = new URL(location.href).searchParams.get("source");
        const nextSource =
          nextDetail.sources.find((source) => source.id === requestedSource)?.id ??
          nextDetail.sources.find((source) => source.id === props.file?.id)?.id ??
          nextDetail.sources[0]?.id ??
          null;
        setSourceId(nextSource);
        const requested = requestedView();
        const nextView =
          requested === "source" && nextDetail.views.preferred === "output"
            ? "output"
            : nextDetail.views[requested]
              ? requested
              : nextDetail.views.preferred;
        setView(nextView);
        setNotice(
          nextView === "output" &&
            nextDetail.views.outputKind === "module-code-generation" &&
            !nextDetail.views.hasMappedOutput
            ? "Mapped generated characters are 0. Falling back to Rspack module code generation; exact final-asset runtime coverage remains unknown."
            : null,
        );
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [moduleId, props.file]);

  useEffect(() => {
    if (!moduleId || !detail) return;
    let cancelled = false;
    setLoadingCode(true);
    void loadCode(moduleId, { view, sourceId, offset: 0, limit: CODE_PAGE })
      .then((nextCode) => {
        if (!cancelled) {
          setCode(nextCode);
          setNotice(nextCode.gap);
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoadingCode(false);
      });
    return () => {
      cancelled = true;
    };
  }, [moduleId, detail, view, sourceId]);

  useEffect(() => {
    if (!moduleId || !detail) return;
    let cancelled = false;
    setLoadingReferences(true);
    void loadReferences(moduleId, direction)
      .then((nextReferences) => {
        if (!cancelled) setReferences(nextReferences);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) setLoadingReferences(false);
      });
    return () => {
      cancelled = true;
    };
  }, [moduleId, detail, direction]);

  useEffect(() => {
    if (!moduleId) return;
    const url = new URL(location.href);
    url.searchParams.set("module", moduleId);
    url.searchParams.set("view", view);
    if (view === "source" && sourceId) url.searchParams.set("source", sourceId);
    else url.searchParams.delete("source");
    history.replaceState(null, "", url);
  }, [moduleId, view, sourceId]);

  if (!props.file) return null;
  const selectedBuildModule = moduleId ? modulesById.get(moduleId) : null;
  const metrics = detail?.metrics ?? props.file.metrics;
  const loaded = metrics.loadedBytes;
  const executedWidth = loaded ? (metrics.executedBytes / loaded) * 100 : 0;
  const unexecutedWidth = loaded ? (metrics.unusedBytes / loaded) * 100 : 0;

  const loadPage = async (offset: number) => {
    if (!moduleId) return;
    setLoadingCode(true);
    try {
      setCode(await loadCode(moduleId, { view, sourceId, offset, limit: CODE_PAGE }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingCode(false);
    }
  };

  const selectEdge = async (edgeId: string) => {
    try {
      const nextSnippet = await loadReferenceSnippet(edgeId);
      setSnippet(nextSnippet);
      setSnippetFlashKey((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="drawer-backdrop">
      <aside
        className="source-drawer investigation-drawer"
        aria-label={`Coverage investigation for ${props.file.path}`}
      >
        <header className="investigation-header">
          <div className="investigation-title">
            <span className="eyebrow">Module investigation</span>
            <h2>{props.file.path.split("/").at(-1)}</h2>
            <code title={selectedBuildModule?.identifier ?? props.file.path}>
              {selectedBuildModule
                ? `${props.file.path} · owned by ${displayModule(selectedBuildModule)}`
                : props.file.path}
            </code>
          </div>
          <div className="investigation-actions">
            {props.file.moduleIds.length > 1 ? (
              <select
                aria-label="Rspack module variant"
                value={moduleId ?? ""}
                onChange={(event) => setModuleId(event.target.value)}
              >
                {props.file.moduleIds.map((id) => {
                  const module = modulesById.get(id);
                  return (
                    <option key={id} value={id}>
                      {module ? displayModule(module) : id}
                    </option>
                  );
                })}
              </select>
            ) : null}
            <button
              type="button"
              className="button button--secondary"
              disabled={!moduleId}
              onClick={() => {
                if (!moduleId) return;
                void openInEditor({ moduleId, sourceId }).catch((cause) =>
                  setError(cause instanceof Error ? cause.message : String(cause)),
                );
              }}
            >
              Open in VS Code
            </button>
            <button
              type="button"
              className="button button--secondary"
              disabled={!moduleId}
              onClick={() => {
                if (!moduleId) return;
                void loadAiContext(moduleId)
                  .then((context) =>
                    navigator.clipboard.writeText(JSON.stringify(context, null, 2)),
                  )
                  .catch((cause) =>
                    setError(cause instanceof Error ? cause.message : String(cause)),
                  );
              }}
            >
              Copy AI context
            </button>
            <button
              type="button"
              className="close-button"
              onClick={props.onClose}
              aria-label="Close source details"
            >
              ×
            </button>
          </div>
        </header>

        <div className="investigation-metrics">
          <span>
            <small>Mapped</small>
            {formatBytes(metrics.mappedBytes)}
          </span>
          <span>
            <small>Loaded</small>
            {formatBytes(metrics.loadedBytes)}
          </span>
          <span className="metric-executed">
            <small>Executed</small>
            {formatBytes(metrics.executedBytes)}
          </span>
          <span className="metric-unexecuted">
            <small>Unexecuted</small>
            {formatBytes(metrics.unusedBytes)}
          </span>
          <span>
            <small>Usage</small>
            {formatPercent(metrics.usageRatio)}
          </span>
          <div
            className="module-coverage-bar"
            role="img"
            aria-label={`Module usage ${formatPercent(metrics.usageRatio)}`}
          >
            <i className="bar-executed" style={{ width: `${executedWidth}%` }} />
            <i className="bar-unexecuted" style={{ width: `${unexecutedWidth}%` }} />
          </div>
        </div>

        {error ? <div className="investigation-error">{error}</div> : null}
        {notice ? <div className="mapping-notice">{notice}</div> : null}

        <div className="investigation-grid">
          <section className="code-workbench">
            <div className="code-toolbar">
              <fieldset className="segmented">
                <legend className="sr-only">Code view</legend>
                <button
                  type="button"
                  className={view === "source" ? "active" : ""}
                  disabled={detail ? !detail.views.source : false}
                  onClick={() => setView("source")}
                >
                  Source
                </button>
                <button
                  type="button"
                  className={view === "output" ? "active" : ""}
                  disabled={detail ? !detail.views.output : true}
                  onClick={() => setView("output")}
                >
                  Final output
                </button>
              </fieldset>
              {view === "source" && (detail?.sources.length ?? 0) > 1 ? (
                <select
                  aria-label="Mapped source"
                  value={sourceId ?? ""}
                  onChange={(event) => setSourceId(event.target.value)}
                >
                  {detail?.sources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.name}
                    </option>
                  ))}
                </select>
              ) : null}
              <div className="code-provenance">
                <strong>{code?.filename ?? "Loading code…"}</strong>
                <small>{code?.provenance ?? ""}</small>
              </div>
              {code?.hasPrevious || code?.hasNext ? (
                <div className="code-pager">
                  <button
                    type="button"
                    disabled={!code.hasPrevious || loadingCode}
                    onClick={() => void loadPage(Math.max(0, code.offset - CODE_PAGE))}
                  >
                    Previous
                  </button>
                  <span>
                    {code.offset.toLocaleString()}–{code.endOffset.toLocaleString()} /{" "}
                    {code.totalCharacters.toLocaleString()}
                  </span>
                  <button
                    type="button"
                    disabled={!code.hasNext || loadingCode}
                    onClick={() => void loadPage(code.endOffset)}
                  >
                    Next
                  </button>
                </div>
              ) : null}
            </div>
            <div className="coverage-code-legend">
              <span>
                <i className="legend-executed" /> executed
              </span>
              <span>
                <i className="legend-unexecuted" /> loaded / unexecuted
              </span>
              <span>
                <i className="legend-not-emitted" /> not emitted
              </span>
              <span>
                <i className="legend-unloaded" /> not loaded
              </span>
              <span>
                <i className="legend-unknown" /> unknown
              </span>
            </div>
            <div className="coverage-code-scroll">
              {loadingCode && !code ? (
                <div className="code-loading">Loading selected code…</div>
              ) : null}
              {code ? <CoverageCode code={code} /> : null}
            </div>
          </section>
          <ReferencePanel
            references={references}
            direction={direction}
            loading={loadingReferences}
            snippet={snippet}
            snippetFlashKey={snippetFlashKey}
            onDirectionChange={(nextDirection) => {
              setDirection(nextDirection);
              setSnippet(null);
            }}
            onSelectEdge={(edgeId) => void selectEdge(edgeId)}
            onLoadMore={() => {
              if (
                !moduleId ||
                references?.nextCursor === null ||
                references?.nextCursor === undefined
              )
                return;
              void loadReferences(moduleId, direction, references.nextCursor).then((next) =>
                setReferences({ ...next, edges: [...references.edges, ...next.edges] }),
              );
            }}
            onCloseSnippet={() => setSnippet(null)}
          />
        </div>
        <footer className="investigation-footer">
          Green and red describe this one recording. Red is not a removability verdict; unknown
          evidence is never coerced into red or gray.
        </footer>
      </aside>
    </div>
  );
}

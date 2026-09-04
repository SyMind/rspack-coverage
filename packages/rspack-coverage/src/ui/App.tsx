import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BuildManifest,
  CoverageAnalysisStatus,
  CoverageImportSummary,
  CoverageReport,
  SourceFileSummary,
} from "../shared/types.js";
import { ChunksView } from "./components/ChunksView.js";
import { MetricCard } from "./components/MetricCard.js";
import { OpportunitiesView } from "./components/OpportunitiesView.js";
import { PathCopyToast } from "./components/PathCopyToast.js";
import { SetupGuide } from "./components/SetupGuide.js";
import { SourceDrawer } from "./components/SourceDrawer.js";
import { SourceExplorer } from "./components/SourceExplorer.js";
import {
  loadBuild,
  loadCoverageAnalysisStatus,
  reuseCoverageAnalysis,
  snapshotDownloadUrl,
  startCoverageAnalysis,
  uploadSnapshot,
} from "./lib/api.js";
import { formatBytes } from "./lib/format.js";

type Tab = "sources" | "chunks" | "opportunities";

interface SelectedSource {
  file: SourceFileSummary;
  moduleId: string | null;
  initialExportName: string | null;
  restoreFromUrl: boolean;
}

function normalizedPath(path: string): string {
  return path.replaceAll("\\\\", "/").replace(/^\/+/, "").split("?", 1)[0] ?? path;
}

function sourceMatchesModule(file: SourceFileSummary, module: BuildManifest["modules"][number]) {
  if (file.moduleIds.includes(module.id)) return true;
  const filePath = normalizedPath(file.path);
  return [module.resource, ...(module.sourcePaths ?? [])]
    .filter((path): path is string => Boolean(path))
    .some((path) => {
      const modulePath = normalizedPath(path);
      return (
        filePath === modulePath ||
        filePath.endsWith(`/${modulePath}`) ||
        modulePath.endsWith(`/${filePath}`)
      );
    });
}

export function App() {
  const [build, setBuild] = useState<BuildManifest | null>(null);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [report, setReport] = useState<CoverageReport | null>(null);
  const [tab, setTab] = useState<Tab>("sources");
  const [selectedSource, setSelectedSource] = useState<SelectedSource | null>(null);
  const selectedFile = selectedSource?.file ?? null;
  const [precision, setPrecision] = useState<CoverageImportSummary["precision"]>("per-block");
  const [recentAvailable, setRecentAvailable] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [snapshotProgress, setSnapshotProgress] = useState<string | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [snapshotDragActive, setSnapshotDragActive] = useState(false);
  const pollingGeneration = useRef(0);
  const snapshotInput = useRef<HTMLInputElement>(null);
  const snapshotImportActive = useRef(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    if (!build || !report) return;
    const restoreDeepLink = () => {
      const search = new URLSearchParams(location.search);
      const moduleId = search.get("module")?.trim() ?? "";
      if (!moduleId) {
        setSelectedSource(null);
        return;
      }
      const module = build.modules.find((candidate) => candidate.id === moduleId);
      if (!module) return;
      const file = report.files.find((candidate) => sourceMatchesModule(candidate, module));
      if (!file) return;
      const initialExportName = search.get("export")?.trim() || null;
      setTab("sources");
      setSelectedSource((current) =>
        current?.file.id === file.id &&
        current.moduleId === moduleId &&
        current.initialExportName === initialExportName &&
        current.restoreFromUrl
          ? current
          : { file, moduleId, initialExportName, restoreFromUrl: true },
      );
    };
    restoreDeepLink();
    window.addEventListener("popstate", restoreDeepLink);
    return () => window.removeEventListener("popstate", restoreDeepLink);
  }, [build, report]);

  const followAnalysis = useCallback(
    async (
      buildHash: string,
      initialStatus: CoverageAnalysisStatus,
      generation = ++pollingGeneration.current,
    ) => {
      let status = initialStatus;
      while (generation === pollingGeneration.current) {
        setRecentAvailable(status.recentAvailable);
        if (status.status === "idle") {
          setProgress(null);
          return;
        }
        if (status.status === "error") {
          setProgress(null);
          setError(status.message);
          return;
        }
        if (status.status === "complete") {
          setReport(status.report);
          setPrecision(status.report.importSummary.precision);
          setProgress(null);
          setTab("sources");
          return;
        }
        setProgress(`${status.phase} · ${status.completed}/${status.total}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (generation !== pollingGeneration.current) return;
        status = await loadCoverageAnalysisStatus(buildHash);
      }
    },
    [],
  );

  const followSafely = useCallback(
    (buildHash: string, status: CoverageAnalysisStatus) => {
      void followAnalysis(buildHash, status).catch((cause) => {
        setProgress(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    },
    [followAnalysis],
  );

  useEffect(() => {
    void loadBuild()
      .then(async (nextBuild) => {
        setBuild(nextBuild);
        const status = await loadCoverageAnalysisStatus(nextBuild.hash);
        followSafely(nextBuild.hash, status);
      })
      .catch((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (message !== "Build data is not ready") setLoadError(message);
      })
      .finally(() => setInitialLoadComplete(true));
    return () => {
      pollingGeneration.current += 1;
    };
  }, [followSafely]);

  const runAnalysis = async (file: File) => {
    if (!build) return;
    pollingGeneration.current += 1;
    setError(null);
    try {
      setProgress(`Uploading ${file.name} to the local Node process…`);
      const currentBuild = await loadBuild();
      if (currentBuild.hash !== build.hash) {
        setBuild(currentBuild);
        setReport(null);
        throw new Error(
          "The build changed while this page was open. Import Coverage recorded from the updated preview.",
        );
      }
      const status = await startCoverageAnalysis(currentBuild.hash, precision, file);
      setRecentAvailable(true);
      followSafely(currentBuild.hash, status);
    } catch (cause) {
      setProgress(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const reuseRecent = async () => {
    if (!build) return;
    pollingGeneration.current += 1;
    setError(null);
    setProgress("Starting Node analysis from the recent recording…");
    try {
      const status = await reuseCoverageAnalysis(build.hash, precision);
      followSafely(build.hash, status);
    } catch (cause) {
      setProgress(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const importSnapshot = async (file: File) => {
    if (snapshotImportActive.current) return;
    snapshotImportActive.current = true;
    pollingGeneration.current += 1;
    setSnapshotError(null);
    setSnapshotProgress(`Uploading ${file.name} (${formatBytes(file.size)})…`);
    try {
      const imported = await uploadSnapshot(file);
      setBuild(imported.build);
      setReport(null);
      setSelectedSource(null);
      const url = new URL(location.href);
      url.searchParams.delete("module");
      url.searchParams.delete("export");
      history.replaceState(null, "", url);
      setTab("sources");
      setError(null);
      setProgress(null);
      setSnapshotProgress("Snapshot verified. Loading its analysis data…");
      const status = await loadCoverageAnalysisStatus(imported.build.hash);
      followSafely(imported.build.hash, status);
      setSnapshotProgress(null);
    } catch (cause) {
      setSnapshotProgress(null);
      setSnapshotError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      snapshotImportActive.current = false;
    }
  };

  const hasDraggedFiles = (event: DragEvent<HTMLElement>) =>
    Array.from(event.dataTransfer.types).includes("Files");

  const onSnapshotDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setSnapshotDragActive(true);
  };

  const onSnapshotDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!snapshotDragActive && !hasDraggedFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setSnapshotDragActive(false);
  };

  const onSnapshotDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) return;
    const alreadyHandled = event.defaultPrevented;
    event.preventDefault();
    dragDepth.current = 0;
    setSnapshotDragActive(false);
    if (alreadyHandled) return;
    const file = event.dataTransfer.files[0];
    if (file) void importSnapshot(file);
  };

  const loadedChunkCount = useMemo(
    () => report?.chunks.filter((chunk) => chunk.loaded).length ?? 0,
    [report],
  );

  return (
    <section
      className="app-shell"
      aria-label="Rspack Coverage workbench"
      onDragEnter={onSnapshotDragEnter}
      onDragOver={(event) => {
        if (hasDraggedFiles(event)) event.preventDefault();
      }}
      onDragLeave={onSnapshotDragLeave}
      onDrop={onSnapshotDrop}
    >
      <header className="topbar topbar--actions-only">
        <div className="topbar-actions">
          {report ? (
            <button
              type="button"
              className="button button--secondary"
              onClick={() => setReport(null)}
            >
              Import another recording
            </button>
          ) : null}
          {build && !progress ? (
            <a
              className="button button--secondary snapshot-download-button"
              href={snapshotDownloadUrl()}
            >
              Download snapshot
            </a>
          ) : null}
          <input
            ref={snapshotInput}
            className="sr-only"
            type="file"
            aria-label="Snapshot file"
            accept=".rspack-coverage,.rspack-coverage-snapshot,application/vnd.rspack.coverage-snapshot"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importSnapshot(file);
            }}
          />
          <button
            type="button"
            className="button snapshot-upload-button"
            disabled={Boolean(snapshotProgress)}
            aria-busy={Boolean(snapshotProgress)}
            onClick={() => snapshotInput.current?.click()}
          >
            {snapshotProgress ? (
              <span className="snapshot-upload-status" aria-hidden="true" />
            ) : null}
            {snapshotProgress ? "Importing snapshot…" : "Upload snapshot"}
          </button>
        </div>
      </header>

      {snapshotDragActive ? (
        <div className="snapshot-drop-overlay" role="status" aria-live="polite">
          <div>
            <span className="snapshot-drop-icon">⇩</span>
            <strong>Drop snapshot to open it</strong>
            <small>The file is streamed to local disk and verified before switching builds.</small>
          </div>
        </div>
      ) : null}

      {snapshotProgress || snapshotError ? (
        <div
          className={`snapshot-toast${snapshotError ? " snapshot-toast--error" : ""}`}
          role={snapshotError ? "alert" : "status"}
        >
          {snapshotProgress ? <span className="spinner" /> : null}
          <span>{snapshotError ?? snapshotProgress}</span>
          {snapshotError ? (
            <button type="button" onClick={() => setSnapshotError(null)} aria-label="Dismiss">
              ×
            </button>
          ) : null}
        </div>
      ) : null}

      <PathCopyToast />

      {!initialLoadComplete && !build ? (
        <div className="app-loading">
          <span className="spinner" /> Loading compilation snapshot…
        </div>
      ) : !build ? (
        <main className="empty-snapshot-shell">
          <span className="eyebrow">Portable build data</span>
          <h1>Open a saved snapshot</h1>
          <p>
            Upload a <code>.rspack-coverage</code> file to inspect a build without running Rspack.
            You can also drop the file anywhere on this page.
          </p>
          <button
            type="button"
            className="button snapshot-upload-button empty-snapshot-button"
            disabled={Boolean(snapshotProgress)}
            aria-busy={Boolean(snapshotProgress)}
            onClick={() => snapshotInput.current?.click()}
          >
            {snapshotProgress ? (
              <span className="snapshot-upload-status" aria-hidden="true" />
            ) : null}
            {snapshotProgress ? "Importing snapshot…" : "Choose snapshot file"}
          </button>
          {loadError ? <div className="import-error empty-snapshot-error">{loadError}</div> : null}
        </main>
      ) : !report ? (
        <SetupGuide
          build={build}
          precision={precision}
          onPrecisionChange={setPrecision}
          onImport={(file) => void runAnalysis(file)}
          recentAvailable={recentAvailable}
          onReuseRecent={() => void reuseRecent()}
          error={error}
          progress={progress}
        />
      ) : (
        <main className="report-shell">
          {report.importSummary.precision !== "per-block" ? (
            <div className="precision-warning report-precision-warning">
              Low/unknown precision: record with JavaScript Per block for line-level decisions.
            </div>
          ) : null}
          <section className="metric-grid">
            <MetricCard
              label="Loaded JS"
              value={report.metrics.loadedBytes}
              note={`${formatBytes(report.moduleMetrics.loadedBytes)} retained module code`}
            />
            <MetricCard
              label="Executed"
              value={report.moduleMetrics.executedBytes}
              tone="green"
              note="retained module code"
            />
            <MetricCard
              label="Unused"
              value={report.moduleMetrics.unusedBytes}
              tone="orange"
              note="retained + loaded, not executed"
            />
            <MetricCard
              label="Usage"
              value={report.moduleMetrics.usageRatio ?? 0}
              kind="percent"
              tone="green"
              note="retained module code"
            />
            <MetricCard
              label="Not loaded"
              value={report.moduleMetrics.notLoadedBytes}
              tone="gray"
              note={`${loadedChunkCount} of ${report.chunks.length} chunks loaded`}
            />
          </section>
          <nav className="tabs" aria-label="Coverage report sections">
            <button
              type="button"
              className={tab === "sources" ? "active" : ""}
              onClick={() => setTab("sources")}
            >
              Sources
            </button>
            <button
              type="button"
              className={tab === "chunks" ? "active" : ""}
              onClick={() => setTab("chunks")}
            >
              Chunks <span>{report.chunks.length}</span>
            </button>
            <button
              type="button"
              className={tab === "opportunities" ? "active" : ""}
              onClick={() => setTab("opportunities")}
            >
              Opportunities <span>{report.opportunities.length}</span>
            </button>
          </nav>
          {tab === "sources" ? (
            <SourceExplorer
              tree={report.tree}
              files={report.files}
              modules={build.modules}
              selectedFileId={selectedFile?.id ?? null}
              selectedModuleId={selectedSource?.moduleId ?? null}
              onSelectFile={(file, moduleId) =>
                setSelectedSource({
                  file,
                  moduleId,
                  initialExportName: null,
                  restoreFromUrl: false,
                })
              }
            />
          ) : tab === "chunks" ? (
            <ChunksView chunks={report.chunks} />
          ) : (
            <OpportunitiesView
              opportunities={report.opportunities}
              files={report.files}
              onSelectFile={(file) =>
                setSelectedSource({
                  file,
                  moduleId: null,
                  initialExportName: null,
                  restoreFromUrl: false,
                })
              }
            />
          )}
        </main>
      )}
      {build ? (
        <SourceDrawer
          key={`${build.hash}:${selectedFile?.id ?? "closed"}:${selectedSource?.moduleId ?? "source"}`}
          buildHash={build.hash}
          file={selectedFile}
          moduleId={selectedSource?.moduleId ?? null}
          initialExportName={selectedSource?.initialExportName ?? null}
          restoreFromUrl={selectedSource?.restoreFromUrl ?? false}
          module={
            selectedSource?.moduleId
              ? (build.modules.find((module) => module.id === selectedSource.moduleId) ?? null)
              : null
          }
          onClose={() => {
            setSelectedSource(null);
            const url = new URL(location.href);
            url.searchParams.delete("module");
            url.searchParams.delete("export");
            history.replaceState(null, "", url);
          }}
        />
      ) : null}
    </section>
  );
}

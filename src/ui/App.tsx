import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BuildManifest,
  ChromeCoverageEntry,
  CoverageImportSummary,
  CoverageReport,
  SourceFileReport,
  WorkerRequest,
  WorkerResponse,
} from "../shared/types.js";
import { ChunksView } from "./components/ChunksView.js";
import { MetricCard } from "./components/MetricCard.js";
import { OpportunitiesView } from "./components/OpportunitiesView.js";
import { SetupGuide } from "./components/SetupGuide.js";
import { SourceDrawer } from "./components/SourceDrawer.js";
import { SourceTree } from "./components/SourceTree.js";
import { TreemapView } from "./components/TreemapView.js";
import { loadAnalysisPayload, loadBuild } from "./lib/api.js";
import { loadRecording, loadReport, saveRecording, saveReport } from "./lib/storage.js";

type Tab = "sources" | "chunks" | "opportunities";

export function App() {
  const [build, setBuild] = useState<BuildManifest | null>(null);
  const [report, setReport] = useState<CoverageReport | null>(null);
  const [tab, setTab] = useState<Tab>("sources");
  const [selectedFile, setSelectedFile] = useState<SourceFileReport | null>(null);
  const [precision, setPrecision] = useState<CoverageImportSummary["precision"]>("per-block");
  const [recentAvailable, setRecentAvailable] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    void loadBuild()
      .then(async (nextBuild) => {
        setBuild(nextBuild);
        const [recording, savedReport] = await Promise.all([
          loadRecording(nextBuild.hash),
          loadReport(nextBuild.hash),
        ]);
        setRecentAvailable(Boolean(recording));
        if (recording) setPrecision(recording.precision);
        if (savedReport) setReport(savedReport);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    return () => workerRef.current?.terminate();
  }, []);

  const runAnalysis = async (coverage: ChromeCoverageEntry[], fileName: string) => {
    if (!build) return;
    setError(null);
    try {
      if (!Array.isArray(coverage))
        throw new Error("Chrome Coverage JSON must contain an array of entries.");
      setProgress(`Reading ${fileName}…`);
      const currentBuild = await loadBuild();
      if (currentBuild.hash !== build.hash) {
        setBuild(currentBuild);
        setReport(null);
        throw new Error(
          "The build changed while this page was open. Import Coverage recorded from the updated preview.",
        );
      }
      const payload = await loadAnalysisPayload(currentBuild, (completed, total) => {
        setProgress(`Loading build assets and source maps · ${completed}/${total}`);
      });
      await saveRecording({
        buildHash: currentBuild.hash,
        coverage,
        precision,
        savedAt: Date.now(),
      });
      setRecentAvailable(true);
      workerRef.current?.terminate();
      const worker = new Worker(new URL("../analyzer/analyzer.worker.ts", import.meta.url), {
        type: "module",
      });
      workerRef.current = worker;
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data;
        if (message.type === "progress") {
          setProgress(`${message.phase} · ${message.completed}/${message.total}`);
        } else if (message.type === "error") {
          setProgress(null);
          setError(message.message);
          worker.terminate();
        } else {
          setReport(message.report);
          setProgress(null);
          setTab("sources");
          void saveReport(message.report);
          worker.terminate();
        }
      };
      worker.onerror = (event) => {
        setProgress(null);
        setError(event.message || "Coverage worker failed.");
      };
      worker.postMessage({
        type: "analyze",
        build: currentBuild,
        coverage,
        maps: payload.maps,
        generatedAssets: payload.generatedAssets,
        originalSources: payload.originalSources,
        precision,
      } satisfies WorkerRequest);
    } catch (cause) {
      setProgress(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const reuseRecent = async () => {
    if (!build) return;
    const recording = await loadRecording(build.hash);
    if (recording) void runAnalysis(recording.coverage, "saved recording");
  };

  const loadedChunkCount = useMemo(
    () => report?.chunks.filter((chunk) => chunk.loaded).length ?? 0,
    [report],
  );

  if (!build) {
    return (
      <div className="app-loading">
        <span className="spinner" />
        {error ?? "Loading compilation snapshot…"}
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/__rspack_coverage__/">
          <span className="brand-mark">R</span>
          <span>
            Rspack Coverage<small>runtime-to-source analysis</small>
          </span>
        </a>
        <div className="build-status">
          <span className="status-light" /> Build {build.hash.slice(0, 10)}
          <small>{build.mode}</small>
        </div>
        {report ? (
          <button
            type="button"
            className="button button--secondary"
            onClick={() => setReport(null)}
          >
            Import another recording
          </button>
        ) : null}
      </header>

      {!report ? (
        <SetupGuide
          build={build}
          precision={precision}
          onPrecisionChange={setPrecision}
          onImport={(coverage, fileName) => void runAnalysis(coverage, fileName)}
          recentAvailable={recentAvailable}
          onReuseRecent={() => void reuseRecent()}
          error={error}
          progress={progress}
        />
      ) : (
        <main className="report-shell">
          <section className="report-heading">
            <div>
              <span className="eyebrow">Imported user journey</span>
              <h1>What loaded, what ran, what remained</h1>
              <p>
                {report.importSummary.matchedAssets} matched assets ·{" "}
                {report.importSummary.ignoredEntries.length} ignored ·{" "}
                {report.importSummary.precision.replace("-", " ")} precision
              </p>
            </div>
            {report.importSummary.precision !== "per-block" ? (
              <div className="precision-warning">
                Low/unknown precision: record with JavaScript Per block for line-level decisions.
              </div>
            ) : null}
          </section>
          <section className="metric-grid">
            <MetricCard
              label="Loaded JS"
              value={report.metrics.loadedBytes}
              note={`${loadedChunkCount} of ${report.chunks.length} chunks`}
            />
            <MetricCard label="Executed" value={report.metrics.executedBytes} tone="green" />
            <MetricCard
              label="Unused"
              value={report.metrics.unusedBytes}
              tone="orange"
              note="loaded, not executed"
            />
            <MetricCard
              label="Usage"
              value={report.metrics.usageRatio ?? 0}
              kind="percent"
              tone="green"
            />
            <MetricCard
              label="Not loaded"
              value={report.metrics.notLoadedBytes}
              tone="gray"
              note="emitted in other chunks"
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
            <div className="sources-grid">
              <SourceTree
                tree={report.tree}
                files={report.files}
                selectedFileId={selectedFile?.id ?? null}
                onSelectFile={setSelectedFile}
              />
              <TreemapView tree={report.tree} files={report.files} onSelectFile={setSelectedFile} />
            </div>
          ) : tab === "chunks" ? (
            <ChunksView chunks={report.chunks} />
          ) : (
            <OpportunitiesView
              opportunities={report.opportunities}
              files={report.files}
              onSelectFile={setSelectedFile}
            />
          )}
        </main>
      )}
      <SourceDrawer file={selectedFile} onClose={() => setSelectedFile(null)} />
    </div>
  );
}

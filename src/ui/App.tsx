import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { SetupGuide } from "./components/SetupGuide.js";
import { SourceDrawer } from "./components/SourceDrawer.js";
import { SourceExplorer } from "./components/SourceExplorer.js";
import {
  loadBuild,
  loadCoverageAnalysisStatus,
  reuseCoverageAnalysis,
  startCoverageAnalysis,
} from "./lib/api.js";

type Tab = "sources" | "chunks" | "opportunities";

export function App() {
  const [build, setBuild] = useState<BuildManifest | null>(null);
  const [report, setReport] = useState<CoverageReport | null>(null);
  const [tab, setTab] = useState<Tab>("sources");
  const [selectedFile, setSelectedFile] = useState<SourceFileSummary | null>(null);
  const [precision, setPrecision] = useState<CoverageImportSummary["precision"]>("per-block");
  const [recentAvailable, setRecentAvailable] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollingGeneration = useRef(0);

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
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
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
          onImport={(file) => void runAnalysis(file)}
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
            <SourceExplorer
              tree={report.tree}
              files={report.files}
              selectedFileId={selectedFile?.id ?? null}
              onSelectFile={setSelectedFile}
            />
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
      <SourceDrawer
        key={`${build.hash}:${selectedFile?.id ?? "closed"}`}
        buildHash={build.hash}
        file={selectedFile}
        onClose={() => {
          setSelectedFile(null);
          const url = new URL(location.href);
          url.searchParams.delete("module");
          url.searchParams.delete("export");
          history.replaceState(null, "", url);
        }}
      />
    </div>
  );
}

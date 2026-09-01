import { useEffect, useMemo, useState } from "react";
import type {
  BuildManifest,
  ChromeCoverageEntry,
  CoverageImportSummary,
  CoverageReport,
  SourceFileReport,
} from "../shared/types.js";
import { ChunksView } from "./components/ChunksView.js";
import { EvidenceGapsDialog } from "./components/EvidenceGapsDialog.js";
import { MetricCard } from "./components/MetricCard.js";
import { OpportunitiesView } from "./components/OpportunitiesView.js";
import { SetupGuide } from "./components/SetupGuide.js";
import { SourceDrawer } from "./components/SourceDrawer.js";
import { SourceExplorer } from "./components/SourceExplorer.js";
import { analyzeOnServer, loadBuild, loadCurrentReport, loadEvidenceGaps } from "./lib/api.js";
import { loadRecording, saveRecording, saveReport } from "./lib/storage.js";

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
  const [evidenceGaps, setEvidenceGaps] = useState<Array<{ kind: string; message: string }>>([]);
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  useEffect(() => {
    void loadBuild()
      .then(async (nextBuild) => {
        setBuild(nextBuild);
        const [recording, currentReport] = await Promise.all([
          loadRecording(nextBuild.hash),
          loadCurrentReport(),
        ]);
        setRecentAvailable(Boolean(recording));
        if (recording) setPrecision(recording.precision);
        if (currentReport?.buildHash === nextBuild.hash) setReport(currentReport);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  useEffect(() => {
    if (!report) return;
    void loadEvidenceGaps()
      .then(setEvidenceGaps)
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    const moduleId = new URL(location.href).searchParams.get("module");
    if (moduleId && !selectedFile) {
      const file = report.files.find((candidate) => candidate.moduleIds.includes(moduleId));
      if (file) setSelectedFile(file);
    }
  }, [report, selectedFile]);

  const runAnalysis = async (coverage: ChromeCoverageEntry[], fileName: string) => {
    if (!build) return;
    setError(null);
    try {
      if (!Array.isArray(coverage))
        throw new Error("Chrome Coverage JSON must contain an array of entries.");
      setProgress(`Validating ${fileName} against build ${build.hash.slice(0, 10)}…`);
      const currentBuild = await loadBuild();
      if (currentBuild.hash !== build.hash) {
        setBuild(currentBuild);
        setReport(null);
        throw new Error(
          "The build changed while this page was open. Import Coverage recorded from the updated preview.",
        );
      }
      await saveRecording({
        buildHash: currentBuild.hash,
        coverage,
        precision,
        savedAt: Date.now(),
      });
      setRecentAvailable(true);
      setProgress("Mapping generated ranges to modules and original sources on the local server…");
      const nextReport = await analyzeOnServer(coverage, precision);
      setReport(nextReport);
      setProgress(null);
      setTab("sources");
      await saveReport(nextReport);
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
            Rspack Coverage<small>runtime-to-module investigation</small>
          </span>
        </a>
        <div className="build-status">
          <span className="status-light" /> Build {build.hash.slice(0, 10)}
          <small>{build.mode}</small>
        </div>
        <div className="topbar-actions">
          {report ? (
            <>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => setEvidenceOpen(true)}
              >
                Evidence gaps <span className="button-count">{evidenceGaps.length}</span>
              </button>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => {
                  setSelectedFile(null);
                  setReport(null);
                }}
              >
                Import another recording
              </button>
            </>
          ) : null}
        </div>
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
              <h1>Module coverage, source evidence, and reference paths</h1>
              <p>
                {report.importSummary.matchedAssets} matched assets ·{" "}
                {build.counts.modules.toLocaleString()} modules ·{" "}
                {(build.counts.references ?? 0).toLocaleString()} references ·{" "}
                {report.importSummary.precision.replace("-", " ")} precision
              </p>
            </div>
            {report.importSummary.precision !== "per-block" ? (
              <div className="precision-warning">
                Low/unknown precision: record with JavaScript Per block for code-range decisions.
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
              label="Unexecuted"
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
        key={selectedFile?.id ?? "closed"}
        file={selectedFile}
        modules={build.modules}
        onClose={() => {
          setSelectedFile(null);
          const url = new URL(location.href);
          url.searchParams.delete("module");
          url.searchParams.delete("view");
          url.searchParams.delete("source");
          history.replaceState(null, "", url);
        }}
      />
      <EvidenceGapsDialog
        open={evidenceOpen}
        gaps={evidenceGaps}
        onClose={() => setEvidenceOpen(false)}
      />
    </div>
  );
}

import type { BuildManifest, CoverageImportSummary } from "../../shared/types.js";

export function SetupGuide(props: {
  build: BuildManifest;
  precision: CoverageImportSummary["precision"];
  onPrecisionChange: (precision: CoverageImportSummary["precision"]) => void;
  onImport: (file: File) => void;
  recentAvailable: boolean;
  onReuseRecent: () => void;
  error: string | null;
  progress: string | null;
}) {
  const capabilityWarnings = [
    props.build.capabilities.usedExports !== "enabled"
      ? "Rspack usedExports data is unavailable; unreferenced exports will be marked unknown."
      : null,
    props.build.capabilities.originalLocations !== "exact"
      ? "A full column source map is unavailable; reference locations may be approximate or unavailable."
      : null,
  ].filter((message): message is string => Boolean(message));
  const readFile = (file: File) => {
    props.onImport(file);
  };

  return (
    <main className="setup-shell">
      <section className="build-card">
        <div>
          <span className="eyebrow">Compilation snapshot</span>
          <h1>Build ready</h1>
          <p>
            Build <code>{props.build.hash.slice(0, 12)}</code> is held locally and ready to match.
          </p>
        </div>
        <div className="build-facts">
          <span>✓ {props.build.counts.chunks} chunks</span>
          <span>✓ {props.build.counts.modules} modules</span>
          <span>
            {props.build.capabilities.sourceMap === "full" ? "✓" : "!"}{" "}
            {props.build.counts.sourceMaps} {props.build.capabilities.sourceMap} source maps
          </span>
          <span>
            {props.build.previewAvailable ? "✓" : "!"} application preview{" "}
            {props.build.previewAvailable ? "available" : "unavailable"}
          </span>
        </div>
      </section>

      {capabilityWarnings.length ? (
        <section className="capability-warning">
          <strong>Analysis capability warning</strong>
          {capabilityWarnings.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </section>
      ) : null}

      {props.build.diagnostics.length > 0 ? (
        <section className="diagnostics">
          <strong>Build diagnostics</strong>
          {props.build.diagnostics.slice(0, 5).map((item) => (
            <p
              key={`${item.severity}:${item.file ?? ""}:${item.moduleName ?? ""}:${item.message}`}
              data-severity={item.severity}
            >
              {item.message}
            </p>
          ))}
        </section>
      ) : null}

      <section className="recording-flow">
        <div className="flow-step">
          <span className="step-number">1</span>
          <div>
            <h2>Open this build</h2>
            <p>
              Use the locally served output so exported script text matches this compilation
              exactly.
            </p>
            <a className="button button--secondary" href="/" target="_blank" rel="noreferrer">
              Open application ↗
            </a>
          </div>
        </div>
        <div className="flow-step">
          <span className="step-number">2</span>
          <div>
            <h2>Record in Chrome</h2>
            <p>
              DevTools → More tools → Coverage → JavaScript → <strong>Per block</strong>. Reload,
              exercise the scenario, then Export.
            </p>
            <label className="precision-field">
              Recording precision
              <select
                value={props.precision}
                onChange={(event) =>
                  props.onPrecisionChange(event.target.value as CoverageImportSummary["precision"])
                }
              >
                <option value="per-block">Per block (recommended)</option>
                <option value="per-function">Per function (low precision)</option>
                <option value="unknown">I’m not sure</option>
              </select>
            </label>
          </div>
        </div>
        <div className="flow-step flow-step--import">
          <span className="step-number">3</span>
          <div>
            <h2>Import Coverage JSON</h2>
            <p>
              The file is streamed only to the local Node process. Analysis data never leaves this
              machine.
            </p>
            <label
              className="drop-zone"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const file = event.dataTransfer.files[0];
                if (file) readFile(file);
              }}
            >
              <input
                type="file"
                accept="application/json,.json"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) readFile(file);
                }}
              />
              <span className="drop-icon">⇩</span>
              <strong>Drop Coverage-*.json here</strong>
              <small>or choose a JSON file</small>
            </label>
            {props.recentAvailable ? (
              <button className="text-button" type="button" onClick={props.onReuseRecent}>
                Re-analyze the last recording for this build
              </button>
            ) : null}
            {props.progress ? (
              <div className="progress-message">
                <span className="spinner" />
                {props.progress}
              </div>
            ) : null}
            {props.error ? <div className="import-error">{props.error}</div> : null}
          </div>
        </div>
      </section>
    </main>
  );
}

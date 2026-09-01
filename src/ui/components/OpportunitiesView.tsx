import type { Opportunity, SourceFileSummary } from "../../shared/types.js";
import { formatBytes, formatPercent } from "../lib/format.js";

const LABELS: Record<Opportunity["kind"], string> = {
  "largest-unused": "Loaded / unexecuted",
  "low-usage": "Low usage",
  duplicated: "Duplication",
  "initial-unused": "Initial chunk",
  collection: "Collection signal",
};

export function OpportunitiesView(props: {
  opportunities: Opportunity[];
  files: SourceFileSummary[];
  onSelectFile: (file: SourceFileSummary) => void;
}) {
  const files = new Map(props.files.map((file) => [file.id, file]));
  return (
    <section className="opportunities-shell">
      <div className="opportunity-intro">
        <span className="eyebrow">Evidence-backed leads</span>
        <h2>Investigation candidates</h2>
        <p>
          These are ranking signals, not promised savings. Unexecuted code may still be required for
          another interaction, route, or side effect.
        </p>
      </div>
      {props.opportunities.length === 0 ? (
        <div className="empty-state">
          No candidate crossed the first-version thresholds in this recording.
        </div>
      ) : (
        <div className="opportunity-grid">
          {props.opportunities.map((opportunity, index) => (
            <button
              type="button"
              className="opportunity-card"
              key={opportunity.id}
              onClick={() => {
                if (!opportunity.fileId) return;
                const file = files.get(opportunity.fileId);
                if (file) props.onSelectFile(file);
              }}
            >
              <div className="opportunity-rank">{String(index + 1).padStart(2, "0")}</div>
              <div className="opportunity-body">
                <span className="pill">{LABELS[opportunity.kind]}</span>
                <h3>{opportunity.title}</h3>
                <code>{opportunity.path}</code>
                <p>{opportunity.description}</p>
                <div className="opportunity-metrics">
                  <span>
                    <small>Loaded</small>
                    {formatBytes(opportunity.metrics.loadedBytes)}
                  </span>
                  <span>
                    <small>Unused</small>
                    {formatBytes(opportunity.metrics.unusedBytes)}
                  </span>
                  <span>
                    <small>Usage</small>
                    {formatPercent(opportunity.metrics.usageRatio)}
                  </span>
                </div>
                <ul>
                  {opportunity.evidence.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

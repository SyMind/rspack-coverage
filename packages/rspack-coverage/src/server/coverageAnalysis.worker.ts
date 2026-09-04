import { parentPort, workerData } from "node:worker_threads";
import {
  type CoverageAnalysisWorkerData,
  type CoverageRangeIndexWorkerData,
  loadCoverageRangeIndex,
  runCoverageAnalysisJob,
} from "./coverageAnalysisRunner.js";

if (!parentPort) throw new Error("Coverage analysis worker requires a parent port.");
const port = parentPort;
const input = workerData as CoverageAnalysisWorkerData | CoverageRangeIndexWorkerData;

if ("kind" in input && input.kind === "coverage-range-index") {
  void loadCoverageRangeIndex(input)
    .then((ranges) => port.postMessage({ type: "coverage-range-index-complete", ranges }))
    .catch((error) =>
      port.postMessage({
        type: "error",
        id: "coverage-range-index",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
} else {
  const analysisInput = input as CoverageAnalysisWorkerData;
  void runCoverageAnalysisJob(analysisInput, (phase, completed, total) => {
    port.postMessage({ type: "progress", id: analysisInput.id, phase, completed, total });
  })
    .then(() => port.postMessage({ type: "complete", id: analysisInput.id }))
    .catch((error) =>
      port.postMessage({
        type: "error",
        id: analysisInput.id,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
}

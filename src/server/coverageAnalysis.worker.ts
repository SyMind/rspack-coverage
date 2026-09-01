import { parentPort, workerData } from "node:worker_threads";
import {
  type CoverageAnalysisWorkerData,
  runCoverageAnalysisJob,
} from "./coverageAnalysisRunner.js";

if (!parentPort) throw new Error("Coverage analysis worker requires a parent port.");
const port = parentPort;
const input = workerData as CoverageAnalysisWorkerData;

void runCoverageAnalysisJob(input, (phase, completed, total) => {
  port.postMessage({ type: "progress", id: input.id, phase, completed, total });
})
  .then(() => port.postMessage({ type: "complete", id: input.id }))
  .catch((error) =>
    port.postMessage({
      type: "error",
      id: input.id,
      message: error instanceof Error ? error.message : String(error),
    }),
  );

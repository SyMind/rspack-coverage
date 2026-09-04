import { parentPort } from "node:worker_threads";
import type { ExportAnalysisInput } from "../shared/types.js";
import { analyzeSourceExports } from "./exportAnalysis.js";

if (!parentPort) throw new Error("Export analysis worker requires a parent port.");
const port = parentPort;

port.on("message", async (message: { id: string; input: ExportAnalysisInput }) => {
  try {
    const report = await analyzeSourceExports(message.input, (phase, completed, total) => {
      port.postMessage({ type: "progress", id: message.id, phase, completed, total });
    });
    port.postMessage({ type: "complete", id: message.id, report });
  } catch (error) {
    port.postMessage({
      type: "error",
      id: message.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

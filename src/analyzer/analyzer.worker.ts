/// <reference lib="webworker" />

import type { WorkerRequest, WorkerResponse } from "../shared/types.js";
import { analyzeCoverage } from "./analyze.js";

const worker = self as unknown as DedicatedWorkerGlobalScope;

worker.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type !== "analyze") return;
  void analyzeCoverage({
    build: event.data.build,
    coverage: event.data.coverage,
    maps: event.data.maps,
    generatedAssets: event.data.generatedAssets,
    originalSources: event.data.originalSources,
    precision: event.data.precision,
    onProgress: (phase, completed, total) => {
      worker.postMessage({ type: "progress", phase, completed, total } satisfies WorkerResponse);
    },
  })
    .then((report) => {
      worker.postMessage({ type: "complete", report } satisfies WorkerResponse);
    })
    .catch((error: unknown) => {
      worker.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      } satisfies WorkerResponse);
    });
});

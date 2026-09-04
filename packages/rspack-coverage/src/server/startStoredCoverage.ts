import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ResolvedRspackCoveragePluginOptions } from "../plugin/types.js";
import type { BuildSnapshot } from "../shared/types.js";
import { AnalysisServer } from "./AnalysisServer.js";
import { openBrowser } from "./openBrowser.js";
import { loadLatestBuildSnapshot, resolveCoverageDataDirectory } from "./snapshotStorage.js";

export interface StartStoredCoverageOptions {
  cwd?: string;
  dataDir?: string;
  port?: number;
  open?: boolean;
  historyApiFallback?: boolean;
}

export interface StoredCoverageServer {
  server: AnalysisServer;
  snapshot: BuildSnapshot | null;
  dataDirectory: string;
  origin: string;
}

export async function startStoredCoverage(
  options: StartStoredCoverageOptions = {},
): Promise<StoredCoverageServer> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const dataDirectory = resolveCoverageDataDirectory(cwd, options.dataDir);
  if (!dataDirectory) throw new Error("A reusable data directory is required.");
  const serverOptions: ResolvedRspackCoveragePluginOptions = {
    port: options.port ?? 4868,
    open: options.open ?? true,
    historyApiFallback: options.historyApiFallback ?? true,
  };
  const snapshot = existsSync(join(dataDirectory, "latest.json"))
    ? await loadLatestBuildSnapshot(dataDirectory)
    : null;
  const server = new AnalysisServer(serverOptions, dataDirectory);
  if (snapshot) server.update(snapshot);
  const port = await server.start();
  const origin = `http://127.0.0.1:${port}`;
  if (serverOptions.open) openBrowser(`${origin}/__rspack_coverage__/`);
  return { server, snapshot, dataDirectory, origin };
}

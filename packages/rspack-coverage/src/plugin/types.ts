export interface RspackCoveragePluginOptions {
  /** Preferred local port. Occupied ports are skipped automatically. @default 4868 */
  port?: number;
  /** Open the analysis page after the first compilation. @default true */
  open?: boolean;
  /** Fall back to the emitted index.html for application routes. @default true */
  historyApiFallback?: boolean;
  /**
   * Persist the latest successful compilation so it can be reopened without
   * running Rspack again. Relative paths resolve from the compiler context.
   * Set to false to keep build data process-local. @default node_modules/.cache/rspack-coverage
   */
  dataDir?: string | false;
}

export interface ResolvedRspackCoveragePluginOptions {
  port: number;
  open: boolean;
  historyApiFallback: boolean;
}

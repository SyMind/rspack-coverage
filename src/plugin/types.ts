export interface RspackCoveragePluginOptions {
  /** Preferred local port. Occupied ports are skipped automatically. @default 4868 */
  port?: number;
  /** Open the analysis page after the first compilation. @default true */
  open?: boolean;
  /** Fall back to the emitted index.html for application routes. @default true */
  historyApiFallback?: boolean;
}

export interface ResolvedRspackCoveragePluginOptions {
  port: number;
  open: boolean;
  historyApiFallback: boolean;
}

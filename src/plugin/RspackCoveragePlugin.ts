import type { Compiler, Stats } from "@rspack/core";
import { AnalysisServer } from "../server/AnalysisServer.js";
import { openBrowser } from "../server/openBrowser.js";
import type { RawSourceMapPayload } from "../shared/types.js";
import { createBuildSnapshot } from "./snapshot.js";
import type { ResolvedRspackCoveragePluginOptions, RspackCoveragePluginOptions } from "./types.js";

const PLUGIN_NAME = "RspackCoveragePlugin";

function resolveOptions(options: RspackCoveragePluginOptions): ResolvedRspackCoveragePluginOptions {
  return {
    port: options.port ?? 4868,
    open: options.open ?? true,
    historyApiFallback: options.historyApiFallback ?? true,
  };
}

function hasUsableFullSourceMap(devtool: unknown): boolean {
  return (
    typeof devtool === "string" &&
    devtool.includes("source-map") &&
    !devtool.includes("cheap") &&
    !devtool.includes("eval") &&
    !devtool.includes("nosources")
  );
}

export class RspackCoveragePlugin {
  readonly #options: ResolvedRspackCoveragePluginOptions;
  #server: AnalysisServer | null = null;
  #opened = false;
  #privateMaps = new WeakMap<object, Map<string, RawSourceMapPayload>>();

  constructor(options: RspackCoveragePluginOptions = {}) {
    this.#options = resolveOptions(options);
  }

  apply(compiler: Compiler): void {
    if (process.env.CI === "true") return;

    if (!hasUsableFullSourceMap(compiler.options.devtool)) {
      compiler.options.devtool = false;
      new compiler.webpack.SourceMapDevToolPlugin({
        test: /\.(?:js|mjs|cjs)$/i,
        filename: "__rspack_coverage_maps__/[file].map",
        append: false,
        columns: true,
        module: true,
        noSources: false,
      }).apply(compiler);

      compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
        const maps = new Map<string, RawSourceMapPayload>();
        this.#privateMaps.set(compilation, maps);
        compilation.hooks.processAssets.tap(
          {
            name: PLUGIN_NAME,
            stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_REPORT,
          },
          () => {
            for (const asset of compilation.getAssets()) {
              if (
                !asset.name.startsWith("__rspack_coverage_maps__/") ||
                !asset.name.endsWith(".map")
              )
                continue;
              try {
                const parsed = JSON.parse(asset.source.source().toString()) as RawSourceMapPayload;
                const generatedName =
                  parsed.file || asset.name.slice("__rspack_coverage_maps__/".length, -4);
                maps.set(generatedName, parsed);
              } catch (error) {
                compilation.warnings.push(
                  new Error(
                    `Rspack Coverage could not read private source map ${asset.name}: ${String(error)}`,
                  ),
                );
              }
              compilation.deleteAsset(asset.name);
            }
          },
        );
      });
    }

    compiler.hooks.done.tapPromise(PLUGIN_NAME, async (stats: Stats) => {
      const snapshot = createBuildSnapshot(
        stats,
        compiler,
        this.#privateMaps.get(stats.compilation),
      );
      if (!this.#server) this.#server = new AnalysisServer(this.#options);
      this.#server.update(snapshot);
      const port = await this.#server.start();
      const origin = `http://127.0.0.1:${port}`;

      if (!this.#opened) {
        this.#opened = true;
        console.log(
          `\nRspack Coverage is ready\n\nApplication:\n${origin}/\n\nCoverage report:\n${origin}/__rspack_coverage__/\n\nPress Ctrl+C to stop.\n`,
        );
        if (this.#options.open) openBrowser(`${origin}/__rspack_coverage__/`);
      }
    });

    if (process.env.RSPACK_COVERAGE_TEST === "true") {
      compiler.hooks.shutdown.tapPromise(PLUGIN_NAME, async () => {
        await this.#server?.close();
      });
    }
  }
}

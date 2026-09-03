import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Compiler, Stats } from "@rspack/core";
import { AnalysisServer } from "../server/AnalysisServer.js";
import { openBrowser } from "../server/openBrowser.js";
import { persistBuildSnapshot, resolveCoverageDataDirectory } from "../server/snapshotStorage.js";
import { assertSnapshotRecordSize } from "../shared/snapshotLimits.js";
import type { BuildSnapshot } from "../shared/types.js";
import { NativeExportUsageCapture } from "./exportUsageCapture.js";
import { createBuildSnapshot, type PrivateSourceMapCapture } from "./snapshot.js";
import type { ResolvedRspackCoveragePluginOptions, RspackCoveragePluginOptions } from "./types.js";

const PLUGIN_NAME = "RspackCoveragePlugin";

interface ConfigurationChange {
  option: string;
  before: string;
  after: string;
  purpose: string;
}

function resolveOptions(options: RspackCoveragePluginOptions): ResolvedRspackCoveragePluginOptions {
  return {
    port: options.port ?? 4868,
    open: options.open ?? true,
    historyApiFallback: options.historyApiFallback ?? true,
  };
}

function displayValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  return String(value);
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

function enableRequiredConfiguration(compiler: Compiler): ConfigurationChange[] {
  const changes: ConfigurationChange[] = [];
  const usesProductionDefaults =
    compiler.options.mode === "production" || compiler.options.mode === undefined;
  const displayEffectiveValue = (value: unknown, defaultValue: unknown) =>
    value === undefined ? `${displayValue(defaultValue)} (default)` : displayValue(value);
  const setBooleanOption = (
    option: "providedExports" | "innerGraph" | "minimize",
    defaultValue: boolean,
    purpose: string,
  ) => {
    const configured = compiler.options.optimization[option];
    const effective = configured ?? defaultValue;
    if (effective === true) return;
    compiler.options.optimization[option] = true;
    changes.push({
      option: `optimization.${option}`,
      before: displayEffectiveValue(configured, defaultValue),
      after: "true",
      purpose,
    });
  };

  const configuredUsedExports = compiler.options.optimization.usedExports;
  const effectiveUsedExports = configuredUsedExports ?? usesProductionDefaults;
  if (effectiveUsedExports !== true && effectiveUsedExports !== "global") {
    compiler.options.optimization.usedExports = true;
    changes.push({
      option: "optimization.usedExports",
      before: displayEffectiveValue(configuredUsedExports, usesProductionDefaults),
      after: "true",
      purpose: "tree shaking",
    });
  }

  const configuredSideEffects = compiler.options.optimization.sideEffects;
  const defaultSideEffects = usesProductionDefaults ? true : "flag";
  const effectiveSideEffects = configuredSideEffects ?? defaultSideEffects;
  if (effectiveSideEffects !== true) {
    compiler.options.optimization.sideEffects = true;
    changes.push({
      option: "optimization.sideEffects",
      before: displayEffectiveValue(configuredSideEffects, defaultSideEffects),
      after: "true",
      purpose: "tree shaking",
    });
  }

  setBooleanOption("providedExports", true, "tree shaking");
  setBooleanOption("innerGraph", usesProductionDefaults, "tree shaking");
  setBooleanOption("minimize", usesProductionDefaults, "minification");

  if (compiler.options.optimization.minimizer?.length === 0) {
    compiler.options.optimization.minimizer = [
      new compiler.webpack.SwcJsMinimizerRspackPlugin(),
      new compiler.webpack.LightningCssMinimizerRspackPlugin(),
    ];
    changes.push({
      option: "optimization.minimizer",
      before: "[]",
      after: "Rspack default minimizers",
      purpose: "minification",
    });
  }

  return changes;
}

function printConfigurationChanges(changes: ConfigurationChange[]): void {
  if (changes.length === 0) return;
  const details = changes
    .map(
      ({ option, before, after, purpose }) => `  - ${option}: ${before} -> ${after} (${purpose})`,
    )
    .join("\n");
  console.warn(
    `\nRspack Coverage enabled required Rspack settings for accurate analysis:\n${details}\n`,
  );
}

export class RspackCoveragePlugin {
  readonly #options: ResolvedRspackCoveragePluginOptions;
  readonly #dataDir: string | false | undefined;
  #server: AnalysisServer | null = null;
  #opened = false;
  #privateMaps = new WeakMap<object, PrivateSourceMapCapture>();
  #exportUsageCaptures = new WeakMap<object, NativeExportUsageCapture>();

  constructor(options: RspackCoveragePluginOptions = {}) {
    this.#options = resolveOptions(options);
    this.#dataDir = options.dataDir;
  }

  apply(compiler: Compiler): void {
    if (process.env.CI === "true") return;
    const dataDirectory = resolveCoverageDataDirectory(compiler.context, this.#dataDir);

    const RsdoctorPlugin = (compiler.webpack as any).experiments?.RsdoctorPlugin as
      | {
          new (options: Record<string, unknown>): { apply(compiler: Compiler): void };
          getCompilationHooks(compilation: object): {
            moduleGraph: {
              tapPromise(name: string, handler: (data: unknown) => Promise<void>): void;
            };
          };
        }
      | undefined;
    if (RsdoctorPlugin?.getCompilationHooks) {
      new RsdoctorPlugin({
        moduleGraphFeatures: ["graph"],
        chunkGraphFeatures: false,
        exportUsageGraph: true,
      }).apply(compiler);
      compiler.hooks.thisCompilation.tap(PLUGIN_NAME, (compilation) => {
        const capture = new NativeExportUsageCapture();
        this.#exportUsageCaptures.set(compilation, capture);
        RsdoctorPlugin.getCompilationHooks(compilation).moduleGraph.tapPromise(
          PLUGIN_NAME,
          async (data) => {
            try {
              capture.capture(data as Parameters<NativeExportUsageCapture["capture"]>[0]);
            } catch (error) {
              compilation.warnings.push(
                new Error(
                  `Rspack Coverage could not retain the native export-usage graph: ${String(error)}`,
                ),
              );
            }
          },
        );
      });
    }

    const configurationChanges = enableRequiredConfiguration(compiler);
    if (!hasUsableFullSourceMap(compiler.options.devtool)) {
      const before = compiler.options.devtool;
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
        const directory = mkdtempSync(join(tmpdir(), "rspack-coverage-maps-"));
        const maps: PrivateSourceMapCapture["maps"] = new Map();
        let disposed = false;
        const capture: PrivateSourceMapCapture = {
          maps,
          dispose() {
            if (disposed) return;
            disposed = true;
            rmSync(directory, { recursive: true, force: true });
          },
        };
        this.#privateMaps.set(compilation, capture);
        let mapIndex = 0;
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
                const raw: unknown = asset.source.source();
                const content = Buffer.isBuffer(raw)
                  ? raw
                  : raw instanceof Uint8Array
                    ? Buffer.from(raw)
                    : Buffer.from(String(raw));
                const generatedName = asset.name.slice("__rspack_coverage_maps__/".length, -4);
                assertSnapshotRecordSize("source map", generatedName, content.byteLength);
                const file = join(directory, `${mapIndex}.map`);
                mapIndex += 1;
                writeFileSync(file, content, { flag: "wx" });
                maps.set(generatedName, { kind: "file", path: file });
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
      configurationChanges.push({
        option: "devtool",
        before: displayValue(before),
        after: "private full source maps",
        purpose: "full source maps",
      });
    }
    printConfigurationChanges(configurationChanges);

    compiler.hooks.done.tapPromise(PLUGIN_NAME, async (stats: Stats) => {
      const privateMaps = this.#privateMaps.get(stats.compilation);
      const exportUsageCapture = this.#exportUsageCaptures.get(stats.compilation);
      let capturedSnapshot: BuildSnapshot;
      try {
        capturedSnapshot = createBuildSnapshot(stats, compiler, privateMaps, exportUsageCapture);
      } catch (error) {
        privateMaps?.dispose();
        throw error;
      } finally {
        this.#privateMaps.delete(stats.compilation);
        exportUsageCapture?.dispose();
        this.#exportUsageCaptures.delete(stats.compilation);
      }
      let snapshot = capturedSnapshot;
      if (dataDirectory && !stats.hasErrors()) {
        try {
          snapshot = await persistBuildSnapshot(capturedSnapshot, dataDirectory);
        } catch (error) {
          console.warn(
            `Rspack Coverage could not persist reusable build data in ${dataDirectory}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (!this.#server) this.#server = new AnalysisServer(this.#options, dataDirectory);
      this.#server.update(snapshot);
      const port = await this.#server.start();
      const origin = `http://127.0.0.1:${port}`;

      if (!this.#opened) {
        this.#opened = true;
        const exportUsage =
          snapshot.manifest.capabilities.usedExports === "enabled"
            ? "enabled"
            : `limited (${snapshot.manifest.capabilities.usedExports})`;
        const sourceLocations = snapshot.manifest.capabilities.originalLocations;
        const reopen = snapshot.storage
          ? `\nReusable data:\n${dataDirectory}\n\nReopen without building:\nrspack-coverage serve${this.#dataDir ? ` --data-dir ${JSON.stringify(dataDirectory)}` : ""}\n`
          : "";
        console.log(
          `\nRspack Coverage is ready\n\nExport usage: ${exportUsage}\nSource locations: ${sourceLocations}\n${reopen}\nApplication:\n${origin}/\n\nCoverage report:\n${origin}/__rspack_coverage__/\n\nPress Ctrl+C to stop.\n`,
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

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { type Configuration, rspack, type Stats } from "@rspack/core";
import { afterEach, describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const testDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = join(testDirectory, "../fixtures/tree-shaking");
const loaderPath = require.resolve("star-export-loader");
const temporaryDirectories: string[] = [];

function compile(configuration: Configuration): Promise<Stats> {
  const compiler = rspack(configuration);
  return new Promise((resolve, reject) => {
    compiler.run((error, stats) => {
      compiler.close((closeError) => {
        if (error || closeError) {
          reject(error ?? closeError);
          return;
        }
        if (!stats) {
          reject(new Error("Rspack did not return compilation stats"));
          return;
        }
        if (stats.hasErrors()) {
          reject(new Error(stats.toString({ all: false, errors: true, errorDetails: true })));
          return;
        }
        resolve(stats);
      });
    });
  });
}

async function build(useLoader: boolean): Promise<{ code: string; outputFile: string }> {
  const outputDirectory = await mkdtemp(join(tmpdir(), "star-export-loader-"));
  temporaryDirectories.push(outputDirectory);
  const outputFile = join(outputDirectory, "bundle.cjs");
  const moduleOptions: Pick<Configuration, "module"> = useLoader
    ? {
        module: {
          rules: [
            {
              test: /runtime-library\.js$/,
              resourceQuery: /^$/,
              enforce: "pre",
              use: [
                {
                  loader: loaderPath,
                  options: { adapters: ["rollup", "esbuild", "rolldown"] },
                },
              ],
            },
          ],
        },
      }
    : {};
  await compile({
    ...moduleOptions,
    context: fixtureDirectory,
    mode: "production",
    target: "node",
    entry: "./consumer.js",
    output: {
      path: outputDirectory,
      filename: "bundle.cjs",
      library: { type: "commonjs2" },
    },
    optimization: {
      usedExports: true,
      sideEffects: true,
      innerGraph: true,
      minimize: true,
    },
  });
  return { code: await readFile(outputFile, "utf8"), outputFile };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Rspack loader integration", () => {
  test("loads the published ESM API in Node", async () => {
    const apiUrl = new URL("../../dist/index.js", import.meta.url).href;
    const expression = [
      `import { createStarExportPlan } from ${JSON.stringify(apiUrl)};`,
      'const source = "const foo = 1; const ns = Object.freeze({ __proto__: null, foo }); export { ns };";',
      "if (!createStarExportPlan(source).transformed) process.exitCode = 1;",
    ].join("\n");
    const result = await execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      expression,
    ]);
    expect(result.stderr).toBe("");
  });

  test("removes unused members from all three restored namespace facades", async () => {
    const baseline = await build(false);
    const optimized = await build(true);

    expect(baseline.code).toContain("STAR_EXPORT_BAR_SHOULD_DISAPPEAR");
    expect(optimized.code).not.toContain("STAR_EXPORT_BAR_SHOULD_DISAPPEAR");
    expect(optimized.code).toContain("STAR_EXPORT_FOO");
    expect(optimized.code).toContain("STAR_EXPORT_UNTOUCHED");

    delete (globalThis as { __STAR_EXPORT_EVALUATION_COUNT__?: number })
      .__STAR_EXPORT_EVALUATION_COUNT__;
    const runtime = require(optimized.outputFile) as { result: Array<number | string> };
    expect(runtime.result).toEqual([
      "STAR_EXPORT_FOO",
      "STAR_EXPORT_FOO",
      "STAR_EXPORT_FOO",
      "STAR_EXPORT_UNTOUCHED",
      1,
    ]);
    delete (globalThis as { __STAR_EXPORT_EVALUATION_COUNT__?: number })
      .__STAR_EXPORT_EVALUATION_COUNT__;

    expect(Buffer.byteLength(optimized.code)).toBeLessThan(Buffer.byteLength(baseline.code));
    expect(gzipSync(optimized.code).byteLength).toBeLessThan(gzipSync(baseline.code).byteLength);
  });
});

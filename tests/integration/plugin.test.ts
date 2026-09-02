import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Compiler, HtmlRspackPlugin, rspack, type Stats } from "@rspack/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RspackCoveragePlugin } from "../../src/plugin/RspackCoveragePlugin.js";
import type { AnalysisServer } from "../../src/server/AnalysisServer.js";
import { startStoredCoverage } from "../../src/server/startStoredCoverage.js";
import type { CoverageAnalysisStatus } from "../../src/shared/types.js";

async function waitForCoverageAnalysis(
  origin: string,
  headers: Record<string, string>,
  buildHash: string,
): Promise<CoverageAnalysisStatus> {
  let payload: CoverageAnalysisStatus = { status: "idle", recentAvailable: false };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    payload = (await fetch(
      `${origin}/__rspack_coverage__/api/coverage-analysis?buildHash=${encodeURIComponent(buildHash)}`,
      { headers },
    ).then((response) => response.json())) as CoverageAnalysisStatus;
    if (payload.status !== "pending") return payload;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return payload;
}

describe("RspackCoveragePlugin", () => {
  let compiler: Compiler | null = null;
  let standaloneServer: AnalysisServer | null = null;
  let temporaryDirectory: string | null = null;
  const originalTestFlag = process.env.RSPACK_COVERAGE_TEST;

  afterEach(async () => {
    if (compiler) await new Promise<void>((resolve) => compiler?.close(() => resolve()));
    compiler = null;
    await standaloneServer?.close();
    standaloneServer = null;
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
    if (originalTestFlag === undefined) delete process.env.RSPACK_COVERAGE_TEST;
    else process.env.RSPACK_COVERAGE_TEST = originalTestFlag;
    vi.restoreAllMocks();
  });

  it("warns about and enables source maps, tree shaking, and minification", async () => {
    process.env.RSPACK_COVERAGE_TEST = "true";
    temporaryDirectory = await mkdtemp(join(tmpdir(), "rspack-coverage-"));
    const entry = join(temporaryDirectory, "index.js");
    const dependency = join(temporaryDirectory, "dependency.js");
    const leaf = join(temporaryDirectory, "leaf.js");
    const loader = join(temporaryDirectory, "identity-source-loader.cjs");
    const output = join(temporaryDirectory, "dist");
    await writeFile(
      dependency,
      "import { leaf } from './leaf.js'; export const live = () => leaf(); export const cold = () => 'cold';\n",
    );
    await writeFile(leaf, "export const leaf = () =>\n  'live';\n");
    await writeFile(
      loader,
      `module.exports = function identitySourceLoader(source) {
  const compact = this.resourcePath.endsWith("leaf.js") ? source.replace(/\\s+/g, " ") : source;
  const mappings = "AAAA" + ",CAAC".repeat(Math.max(0, compact.length - 1));
  this.callback(null, compact, {
    version: 3,
    file: this.resourcePath,
    sources: [this.resourcePath.endsWith("leaf.js") ? this.resourcePath : "virtual/inner.js"],
    sourcesContent: [compact],
    names: [],
    mappings,
  });
};
`,
    );
    await writeFile(
      entry,
      "import { live } from './dependency.js'; document.body.textContent = live();\n",
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    compiler = rspack({
      mode: "development",
      context: temporaryDirectory,
      entry,
      devtool: false,
      module: { rules: [{ test: /(?:dependency|leaf)\.js$/, use: [loader] }] },
      optimization: {
        concatenateModules: true,
        usedExports: false,
        minimize: false,
        minimizer: [],
      },
      output: { path: output, filename: "main.js", publicPath: "auto", clean: true },
      plugins: [new HtmlRspackPlugin(), new RspackCoveragePlugin({ port: 49840, open: false })],
    });
    expect(compiler.options.mode).toBe("development");
    expect(compiler.options.devtool).toBe(false);
    expect(compiler.options.optimization.usedExports).toBe(true);
    expect(compiler.options.optimization.sideEffects).toBe(true);
    expect(compiler.options.optimization.providedExports).toBe(true);
    expect(compiler.options.optimization.innerGraph).toBe(true);
    expect(compiler.options.optimization.minimize).toBe(true);
    expect(compiler.options.optimization.minimizer?.length).toBeGreaterThan(0);
    const warningText = warn.mock.calls.flat().join("\n");
    expect(warningText).toContain("Rspack Coverage enabled required Rspack settings");
    expect(warningText).toContain("devtool: false -> private full source maps");
    expect(warningText).toContain("optimization.usedExports: false -> true");
    expect(warningText).toContain('optimization.sideEffects: "flag" (default) -> true');
    expect(warningText).toContain("optimization.innerGraph: false (default) -> true");
    expect(warningText).toContain("optimization.minimize: false -> true");
    expect(warningText).toContain("optimization.minimizer: [] -> Rspack default minimizers");
    const stats = await new Promise<Stats>((resolve, reject) => {
      compiler?.run((error, result) =>
        error ? reject(error) : result ? resolve(result) : reject(new Error("Missing stats")),
      );
    });
    expect(stats.hasErrors()).toBe(false);
    const outputText = log.mock.calls.flat().join("\n");
    const origin = outputText.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    expect(origin).toBeTruthy();

    const html = await fetch(`${origin}/__rspack_coverage__/`).then((response) => response.text());
    const token = html.match(/name="rspack-coverage-token" content="([^"]+)"/)?.[1];
    expect(token).toBeTruthy();
    expect((await fetch(`${origin}/__rspack_coverage__/api/build`)).status).toBe(401);
    const headers = { "X-Rspack-Coverage-Token": token ?? "" };
    const manifest = (await fetch(`${origin}/__rspack_coverage__/api/build`, {
      headers,
    }).then((response) => response.json())) as {
      hash: string;
      counts: { sourceMaps: number; references: number; codeGenerationSources?: number };
      capabilities: {
        usedExports: string;
        sourceMap: string;
        originalLocations: string;
      };
      previewAvailable: boolean;
      assets: Array<{ id: string; urlPath: string }>;
    };
    expect(manifest.counts.sourceMaps).toBeGreaterThan(0);
    expect(manifest.counts.references).toBeGreaterThan(0);
    expect(manifest.counts.codeGenerationSources).toBeGreaterThan(0);
    expect(manifest.capabilities).toEqual({
      usedExports: "enabled",
      sourceMap: "full",
      originalLocations: "exact",
    });
    expect(manifest.previewAvailable).toBe(true);
    expect(await fetch(`${origin}/`).then((response) => response.text())).toContain("<script");

    const files = await readdir(output);
    expect(files.some((file) => file.endsWith(".map"))).toBe(false);
    const generated = await readFile(join(output, "main.js"), "utf8");
    expect(generated).not.toContain("sourceMappingURL");

    const recording = JSON.stringify([
      {
        url: `${origin}/main.js`,
        text: generated,
        ranges: [{ start: 0, end: generated.length }],
      },
    ]);
    const upload = await fetch(
      `${origin}/__rspack_coverage__/api/coverage-analysis?buildHash=${encodeURIComponent(manifest.hash)}&precision=per-block`,
      { method: "POST", headers, body: recording },
    );
    expect(upload.status).toBe(202);
    expect((await upload.json()).status).toBe("pending");

    const completed = await waitForCoverageAnalysis(origin as string, headers, manifest.hash);
    expect(completed.status).toBe("complete");
    if (completed.status !== "complete") throw new Error("Coverage analysis did not complete");
    expect(completed.report.buildHash).toBe(manifest.hash);
    expect(completed.report.importSummary.matchedAssets).toBe(1);
    expect(completed.report.metrics.loadedBytes).toBeGreaterThan(0);
    const source = completed.report.files.find((file) => file.path.endsWith("index.js"));
    expect(source).toBeDefined();
    expect(source).not.toHaveProperty("content");
    expect(source).not.toHaveProperty("lines");
    const sourceDetailResponse = await fetch(
      `${origin}/__rspack_coverage__/api/coverage-analysis/source?buildHash=${encodeURIComponent(manifest.hash)}&fileId=${encodeURIComponent(source?.id ?? "")}`,
      { headers },
    );
    expect(sourceDetailResponse.status).toBe(200);
    const sourceDetail = (await sourceDetailResponse.json()) as {
      id: string;
      lines: Array<{ text: string }>;
    };
    expect(sourceDetail.id).toBe(source?.id);
    expect(sourceDetail.lines.some((line) => line.text.includes("document.body"))).toBe(true);
    expect(
      await fetch(
        `${origin}/__rspack_coverage__/api/coverage-analysis/source?buildHash=${encodeURIComponent(manifest.hash)}&fileId=${encodeURIComponent("missing-source.js")}`,
        { headers },
      ).then((response) => response.status),
    ).toBe(404);

    const dependencySource = completed.report.files.find((file) =>
      file.path.endsWith("dependency.js"),
    );
    const moduleId = dependencySource?.moduleIds[0] ?? "";
    expect(moduleId).not.toBe("");
    const references = (await fetch(
      `${origin}/__rspack_coverage__/api/modules/${encodeURIComponent(moduleId)}/references?direction=in`,
      { headers },
    ).then((response) => response.json())) as {
      total: number;
      counts: { in: number; out: number; both: number };
      edges: Array<{ id: string; exports: string[] | null }>;
      entryPath: Array<{ entry: boolean }>;
    };
    expect(references.total).toBeGreaterThan(0);
    expect(references.counts.in).toBe(references.total);
    expect(references.counts.both).toBeGreaterThanOrEqual(references.counts.in);
    expect(references.entryPath.at(-1)?.entry).toBe(true);
    const liveReference = references.edges.find((edge) => edge.exports?.includes("live"));
    expect(liveReference).toBeTruthy();
    const snippet = (await fetch(
      `${origin}/__rspack_coverage__/api/references/${encodeURIComponent(liveReference?.id ?? "")}/snippet`,
      { headers },
    ).then((response) => response.json())) as {
      available: boolean;
      code: {
        content: string;
        spans: Array<{ status: string }>;
      };
      highlight: { start: number; end: number };
    };
    expect(snippet.available).toBe(true);
    expect(snippet.code.content).toContain("document.body");
    expect(snippet.code.content.slice(snippet.highlight.start, snippet.highlight.end)).toContain(
      "live",
    );
    expect(snippet.code.spans.some((span) => span.status !== "unknown")).toBe(true);

    const reuse = await fetch(
      `${origin}/__rspack_coverage__/api/coverage-analysis/reuse?buildHash=${encodeURIComponent(manifest.hash)}&precision=per-function`,
      { method: "POST", headers },
    );
    expect(reuse.status).toBe(202);
    const reused = await waitForCoverageAnalysis(origin as string, headers, manifest.hash);
    expect(reused.status).toBe("complete");
    if (reused.status !== "complete") throw new Error("Reused Coverage analysis did not complete");
    expect(reused.report.importSummary.precision).toBe("per-function");
  });

  it("keeps an already suitable build configuration without warning", () => {
    temporaryDirectory = join(tmpdir(), "rspack-coverage-configured");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    compiler = rspack({
      mode: "production",
      context: process.cwd(),
      entry: "./src/index.ts",
      devtool: "hidden-source-map",
      plugins: [new RspackCoveragePlugin({ open: false })],
    });

    expect(compiler.options.devtool).toBe("hidden-source-map");
    expect(compiler.options.optimization.usedExports).toBe(true);
    expect(compiler.options.optimization.sideEffects).toBe(true);
    expect(compiler.options.optimization.providedExports).toBe(true);
    expect(compiler.options.optimization.innerGraph).toBe(true);
    expect(compiler.options.optimization.minimize).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    temporaryDirectory = null;
  });

  it("reopens the latest build and Coverage report after the compiler closes", async () => {
    process.env.RSPACK_COVERAGE_TEST = "true";
    temporaryDirectory = await mkdtemp(join(tmpdir(), "rspack-coverage-reopen-"));
    const entry = join(temporaryDirectory, "index.js");
    const output = join(temporaryDirectory, "dist");
    const dataDirectory = join(temporaryDirectory, "coverage-data");
    await writeFile(entry, "document.body.textContent = 'restored';\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    compiler = rspack({
      mode: "production",
      context: temporaryDirectory,
      entry,
      devtool: false,
      output: { path: output, filename: "main.js", publicPath: "auto", clean: true },
      plugins: [
        new HtmlRspackPlugin(),
        new RspackCoveragePlugin({
          port: 49880,
          open: false,
          dataDir: dataDirectory,
        }),
      ],
    });
    const stats = await new Promise<Stats>((resolve, reject) => {
      compiler?.run((error, result) =>
        error ? reject(error) : result ? resolve(result) : reject(new Error("Missing stats")),
      );
    });
    expect(stats.hasErrors()).toBe(false);
    const firstOrigin = log.mock.calls
      .flat()
      .join("\n")
      .match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    expect(firstOrigin).toBeTruthy();
    const firstHtml = await fetch(`${firstOrigin}/__rspack_coverage__/`).then((response) =>
      response.text(),
    );
    const firstToken = firstHtml.match(/name="rspack-coverage-token" content="([^"]+)"/)?.[1];
    const firstHeaders = { "X-Rspack-Coverage-Token": firstToken ?? "" };
    const manifest = (await fetch(`${firstOrigin}/__rspack_coverage__/api/build`, {
      headers: firstHeaders,
    }).then((response) => response.json())) as { hash: string };
    const generated = await readFile(join(output, "main.js"), "utf8");
    await fetch(
      `${firstOrigin}/__rspack_coverage__/api/coverage-analysis?buildHash=${encodeURIComponent(manifest.hash)}&precision=per-block`,
      {
        method: "POST",
        headers: firstHeaders,
        body: JSON.stringify([
          {
            url: `${firstOrigin}/main.js`,
            text: generated,
            ranges: [{ start: 0, end: generated.length }],
          },
        ]),
      },
    );
    const completed = await waitForCoverageAnalysis(
      firstOrigin as string,
      firstHeaders,
      manifest.hash,
    );
    expect(completed.status).toBe("complete");
    const snapshotDownload = await fetch(`${firstOrigin}/__rspack_coverage__/api/snapshot`, {
      headers: firstHeaders,
    });
    expect(snapshotDownload.status).toBe(200);
    expect(snapshotDownload.headers.get("content-disposition")).toContain(".rspack-coverage");
    const portableSnapshot = Buffer.from(await snapshotDownload.arrayBuffer());
    expect(portableSnapshot.byteLength).toBeGreaterThan(0);

    await new Promise<void>((resolve) => compiler?.close(() => resolve()));
    compiler = null;
    await rm(output, { recursive: true, force: true });
    await rm(entry, { force: true });

    const restored = await startStoredCoverage({
      cwd: temporaryDirectory,
      dataDir: dataDirectory,
      port: 49920,
      open: false,
    });
    standaloneServer = restored.server;
    expect(restored.snapshot?.manifest.hash).toBe(manifest.hash);
    expect(await fetch(`${restored.origin}/`).then((response) => response.text())).toContain(
      "<script",
    );
    expect(await fetch(`${restored.origin}/main.js`).then((response) => response.text())).toBe(
      generated,
    );
    const restoredHtml = await fetch(`${restored.origin}/__rspack_coverage__/`).then((response) =>
      response.text(),
    );
    const restoredToken = restoredHtml.match(/name="rspack-coverage-token" content="([^"]+)"/)?.[1];
    const restoredHeaders = { "X-Rspack-Coverage-Token": restoredToken ?? "" };
    const snapshotUpload = await fetch(`${restored.origin}/__rspack_coverage__/api/snapshot`, {
      method: "POST",
      headers: restoredHeaders,
      body: portableSnapshot,
    });
    expect(snapshotUpload.status).toBe(200);
    expect(await snapshotUpload.json()).toMatchObject({
      bytes: portableSnapshot.byteLength,
      build: { hash: manifest.hash },
    });
    const restoredStatus = (await fetch(
      `${restored.origin}/__rspack_coverage__/api/coverage-analysis?buildHash=${encodeURIComponent(manifest.hash)}`,
      { headers: restoredHeaders },
    ).then((response) => response.json())) as CoverageAnalysisStatus;
    expect(restoredStatus.status).toBe("complete");
    if (restoredStatus.status === "complete") {
      expect(restoredStatus.report.importSummary.matchedAssets).toBe(1);
    }
  });

  it("opens an upload-ready workbench when no saved snapshot exists", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "rspack-coverage-empty-"));
    const running = await startStoredCoverage({
      cwd: temporaryDirectory,
      dataDir: join(temporaryDirectory, "empty-data"),
      port: 49940,
      open: false,
    });
    standaloneServer = running.server;
    expect(running.snapshot).toBeNull();
    const html = await fetch(`${running.origin}/__rspack_coverage__/`).then((response) =>
      response.text(),
    );
    const token = html.match(/name="rspack-coverage-token" content="([^"]+)"/)?.[1];
    expect(token).toBeTruthy();
    expect(
      await fetch(`${running.origin}/__rspack_coverage__/api/build`, {
        headers: { "X-Rspack-Coverage-Token": token ?? "" },
      }).then((response) => response.status),
    ).toBe(503);
    expect(
      await fetch(`${running.origin}/__rspack_coverage__/api/snapshot`, {
        method: "POST",
        headers: { "X-Rspack-Coverage-Token": token ?? "" },
        body: "not a snapshot",
      }).then((response) => response.status),
    ).toBe(400);
  });

  it("serves on-demand export usage from Stats and the direct ModuleGraph", async () => {
    process.env.RSPACK_COVERAGE_TEST = "true";
    temporaryDirectory = await mkdtemp(join(tmpdir(), "rspack-coverage-exports-"));
    const entry = join(temporaryDirectory, "index.js");
    const exportsFile = join(temporaryDirectory, "exports.js");
    const commonJsExportsFile = join(temporaryDirectory, "common.cjs");
    const output = join(temporaryDirectory, "dist");
    await writeFile(
      exportsFile,
      [
        "export const ACTIONS = { next: () => 'next' };",
        "export const EVENTS = { skipped: () => 'skipped' };",
      ].join("\n"),
    );
    await writeFile(
      commonJsExportsFile,
      [
        "exports.normal = void 0;",
        "exports.normal = () => 'normal';",
        "exports.skipped = () => 'skipped';",
      ].join("\n"),
    );
    await writeFile(
      entry,
      [
        "import { ACTIONS } from './exports.js';",
        "const { normal } = require('./common.cjs');",
        "document.body.textContent = ACTIONS.next() + normal();",
      ].join("\n"),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    compiler = rspack({
      mode: "production",
      context: temporaryDirectory,
      entry,
      devtool: false,
      output: { path: output, filename: "main.js", publicPath: "auto", clean: true },
      plugins: [new HtmlRspackPlugin(), new RspackCoveragePlugin({ port: 49860, open: false })],
    });
    const stats = await new Promise<Stats>((resolve, reject) => {
      compiler?.run((error, result) =>
        error ? reject(error) : result ? resolve(result) : reject(new Error("Missing stats")),
      );
    });
    expect(stats.hasErrors()).toBe(false);
    const origin = log.mock.calls
      .flat()
      .join("\n")
      .match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    expect(origin).toBeTruthy();
    const html = await fetch(`${origin}/__rspack_coverage__/`).then((response) => response.text());
    const token = html.match(/name="rspack-coverage-token" content="([^"]+)"/)?.[1];
    const headers = { "X-Rspack-Coverage-Token": token ?? "" };
    const manifest = (await fetch(`${origin}/__rspack_coverage__/api/build`, { headers }).then(
      (response) => response.json(),
    )) as { hash: string; capabilities: { usedExports: string } };
    expect(manifest.capabilities.usedExports).toBe("enabled");

    let status = 202;
    let payload: any = null;
    for (let attempt = 0; attempt < 50 && status === 202; attempt += 1) {
      const response = await fetch(
        `${origin}/__rspack_coverage__/api/source-exports?buildHash=${encodeURIComponent(manifest.hash)}&source=${encodeURIComponent("exports.js")}`,
        { headers },
      );
      status = response.status;
      payload = await response.json();
      if (status === 202) await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(status).toBe(200);
    expect(
      payload.report.exports.find((item: any) => item.exportedName === "ACTIONS"),
    ).toMatchObject({
      state: "used",
      precision: "exact",
    });
    expect(
      payload.report.exports.find((item: any) => item.exportedName === "EVENTS"),
    ).toMatchObject({
      state: "unused",
      precision: "exact",
    });

    status = 202;
    payload = null;
    for (let attempt = 0; attempt < 50 && status === 202; attempt += 1) {
      const response = await fetch(
        `${origin}/__rspack_coverage__/api/source-exports?buildHash=${encodeURIComponent(manifest.hash)}&source=${encodeURIComponent("common.cjs")}`,
        { headers },
      );
      status = response.status;
      payload = await response.json();
      if (status === 202) await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(status).toBe(200);
    expect(
      payload.report.exports.find((item: any) => item.exportedName === "normal"),
    ).toMatchObject({
      state: "used",
      precision: "exact",
      range: {
        start: { line: 2, column: 8 },
        end: { line: 2, column: 14 },
      },
    });
  });
});

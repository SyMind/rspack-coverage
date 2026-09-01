import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Compiler, HtmlRspackPlugin, rspack, type Stats } from "@rspack/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RspackCoveragePlugin } from "../../src/plugin/RspackCoveragePlugin.js";

describe("RspackCoveragePlugin", () => {
  let compiler: Compiler | null = null;
  let temporaryDirectory: string | null = null;
  const originalTestFlag = process.env.RSPACK_COVERAGE_TEST;

  afterEach(async () => {
    if (compiler) await new Promise<void>((resolve) => compiler?.close(() => resolve()));
    compiler = null;
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
    if (originalTestFlag === undefined) delete process.env.RSPACK_COVERAGE_TEST;
    else process.env.RSPACK_COVERAGE_TEST = originalTestFlag;
    vi.restoreAllMocks();
  });

  it("creates a private full map, serves the app, and token-protects build data", async () => {
    process.env.RSPACK_COVERAGE_TEST = "true";
    temporaryDirectory = await mkdtemp(join(tmpdir(), "rspack-coverage-"));
    const entry = join(temporaryDirectory, "index.js");
    const dependency = join(temporaryDirectory, "dependency.js");
    const output = join(temporaryDirectory, "dist");
    await writeFile(
      dependency,
      "export const live = () => 'live'; export const cold = () => 'cold';\n",
    );
    await writeFile(
      entry,
      "import { live } from './dependency.js'; document.body.textContent = live();\n",
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    compiler = rspack({
      mode: "production",
      context: temporaryDirectory,
      entry,
      devtool: false,
      optimization: { concatenateModules: false },
      output: { path: output, filename: "main.js", publicPath: "auto", clean: true },
      plugins: [new HtmlRspackPlugin(), new RspackCoveragePlugin({ port: 49840, open: false })],
    });
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
    const manifest = (await fetch(`${origin}/__rspack_coverage__/api/build`, {
      headers: { "X-Rspack-Coverage-Token": token ?? "" },
    }).then((response) => response.json())) as {
      counts: { sourceMaps: number; references: number };
      previewAvailable: boolean;
      assets: Array<{ id: string; urlPath: string }>;
    };
    expect(manifest.counts.sourceMaps).toBeGreaterThan(0);
    expect(manifest.counts.references).toBeGreaterThan(0);
    expect(manifest.previewAvailable).toBe(true);
    const malformedAnalysis = await fetch(`${origin}/__rspack_coverage__/api/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Rspack-Coverage-Token": token ?? "",
      },
      body: "{",
    });
    expect(malformedAnalysis.status).toBe(400);
    expect(await malformedAnalysis.json()).toHaveProperty("error");
    const sources = (await fetch(`${origin}/__rspack_coverage__/api/sources`, {
      headers: { "X-Rspack-Coverage-Token": token ?? "" },
    }).then((response) => response.json())) as Array<{ path: string; characters: number }>;
    expect(sources.some((source) => source.path.endsWith("index.js"))).toBe(true);
    expect(sources.every((source) => !("content" in source))).toBe(true);

    const asset = manifest.assets[0];
    expect(asset).toBeTruthy();
    const generated = await fetch(
      `${origin}/__rspack_coverage__/api/asset/${encodeURIComponent(asset?.id ?? "")}`,
      { headers: { "X-Rspack-Coverage-Token": token ?? "" } },
    ).then((response) => response.text());
    const report = (await fetch(`${origin}/__rspack_coverage__/api/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Rspack-Coverage-Token": token ?? "",
      },
      body: JSON.stringify({
        coverage: [
          {
            url: asset?.urlPath,
            text: generated,
            ranges: [{ start: 0, end: Math.max(1, Math.floor(generated.length / 2)) }],
          },
        ],
        precision: "per-block",
      }),
    }).then((response) => response.json())) as {
      files: Array<{ id: string; path: string; moduleIds: string[]; content: null; lines: [] }>;
    };
    expect(report.files.every((file) => file.content === null && file.lines.length === 0)).toBe(
      true,
    );
    const dependencySource = report.files.find((file) => file.path.endsWith("dependency.js"));
    expect(dependencySource?.moduleIds.length).toBeGreaterThan(0);
    const sourceDetail = (await fetch(
      `${origin}/__rspack_coverage__/api/source?id=${encodeURIComponent(dependencySource?.id ?? "")}`,
      { headers: { "X-Rspack-Coverage-Token": token ?? "" } },
    ).then((response) => response.json())) as { content: string; lines: unknown[] };
    expect(sourceDetail.content).toContain("export const live");
    expect(sourceDetail.lines.length).toBeGreaterThan(0);
    const moduleId = dependencySource?.moduleIds[0] ?? "";
    const moduleDetail = (await fetch(`${origin}/__rspack_coverage__/api/modules/${moduleId}`, {
      headers: { "X-Rspack-Coverage-Token": token ?? "" },
    }).then((response) => response.json())) as {
      views: { output: boolean; codeGeneration: boolean };
    };
    expect(moduleDetail.views).toMatchObject({ output: true, codeGeneration: true });
    const references = (await fetch(
      `${origin}/__rspack_coverage__/api/modules/${moduleId}/references?direction=in`,
      { headers: { "X-Rspack-Coverage-Token": token ?? "" } },
    ).then((response) => response.json())) as {
      total: number;
      edges: Array<{ id: string; exports: string[] | null }>;
    };
    expect(references.total).toBeGreaterThan(0);
    const liveReference = references.edges.find((edge) => edge.exports?.includes("live"));
    expect(liveReference).toBeTruthy();
    const snippet = (await fetch(
      `${origin}/__rspack_coverage__/api/references/${liveReference?.id}/snippet`,
      { headers: { "X-Rspack-Coverage-Token": token ?? "" } },
    ).then((response) => response.json())) as {
      available: boolean;
      content: string;
      highlight: { start: number; end: number };
    };
    expect(snippet.available).toBe(true);
    expect(snippet.content).toContain("dependency.js");
    expect(snippet.content.slice(snippet.highlight.start, snippet.highlight.end)).toBe("live");
    expect(await fetch(`${origin}/`).then((response) => response.text())).toContain("<script");

    const files = await readdir(output);
    expect(files.some((file) => file.endsWith(".map"))).toBe(false);
    expect(await readFile(join(output, "main.js"), "utf8")).not.toContain("sourceMappingURL");
  });
});

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
    const output = join(temporaryDirectory, "dist");
    await writeFile(
      entry,
      "const live = () => 'live'; const cold = () => 'cold'; document.body.textContent = live(); export { cold };\n",
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    compiler = rspack({
      mode: "production",
      context: temporaryDirectory,
      entry,
      devtool: false,
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
      counts: { sourceMaps: number };
      previewAvailable: boolean;
    };
    expect(manifest.counts.sourceMaps).toBeGreaterThan(0);
    expect(manifest.previewAvailable).toBe(true);
    const sources = (await fetch(`${origin}/__rspack_coverage__/api/sources`, {
      headers: { "X-Rspack-Coverage-Token": token ?? "" },
    }).then((response) => response.json())) as Record<string, string>;
    expect(Object.keys(sources).some((source) => source.endsWith("index.js"))).toBe(true);
    expect(await fetch(`${origin}/`).then((response) => response.text())).toContain("<script");

    const files = await readdir(output);
    expect(files.some((file) => file.endsWith(".map"))).toBe(false);
    expect(await readFile(join(output, "main.js"), "utf8")).not.toContain("sourceMappingURL");
  });
});

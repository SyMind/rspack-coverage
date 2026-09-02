import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResolvedRspackCoveragePluginOptions } from "../plugin/types.js";
import { sourceLineCoverageStatus, sourceLinesCoverageSpans } from "../shared/codeCoverage.js";
import { MAX_PORTABLE_SNAPSHOT_BYTES } from "../shared/snapshotLimits.js";
import type { BuildSnapshot } from "../shared/types.js";
import {
  CoverageAnalysisService,
  type CoverageAnalysisView,
  CoverageBuildChangedError,
  CoverageReportNotReadyError,
  CoverageUploadTooLargeError,
  MissingCoverageRecordingError,
  MissingCoverageSourceError,
  parseCoveragePrecision,
} from "./CoverageAnalysisService.js";
import { ExportAnalysisService } from "./ExportAnalysisService.js";
import { InvestigationModel } from "./InvestigationModel.js";
import {
  createPortableSnapshotArchive,
  importPortableSnapshot,
  PortableSnapshotFormatError,
  PortableSnapshotTooLargeError,
} from "./portableSnapshot.js";

const ANALYSIS_PREFIX = "/__rspack_coverage__/";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function contentType(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export class AnalysisServer {
  readonly token = randomBytes(24).toString("base64url");
  #snapshot: BuildSnapshot | null = null;
  #server = createServer((request, response) => void this.#handle(request, response));
  #port: number | null = null;
  #uiDirectory: string;
  #coverageAnalysis = new CoverageAnalysisService();
  #exportAnalysis = new ExportAnalysisService();
  #investigation: InvestigationModel | null = null;
  #temporaryDataDirectory: Promise<string> | null = null;
  #snapshotImporting = false;

  constructor(
    private readonly options: ResolvedRspackCoveragePluginOptions,
    private readonly dataDirectory: string | null = null,
  ) {
    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(moduleDirectory, "ui"),
      resolve(moduleDirectory, "../../dist/ui"),
      resolve(process.cwd(), "dist/ui"),
    ];
    this.#uiDirectory =
      candidates.find((candidate) => existsSync(join(candidate, "index.html"))) ??
      resolve(moduleDirectory, "ui");
  }

  get port(): number | null {
    return this.#port;
  }

  get origin(): string | null {
    return this.#port ? `http://127.0.0.1:${this.#port}` : null;
  }

  update(snapshot: BuildSnapshot, force = false): void {
    const previousIdentity =
      this.#snapshot?.storage?.snapshotId ??
      (this.#snapshot
        ? `memory:${this.#snapshot.manifest.hash}:${this.#snapshot.manifest.builtAt}`
        : null);
    const nextIdentity =
      snapshot.storage?.snapshotId ??
      `memory:${snapshot.manifest.hash}:${snapshot.manifest.builtAt}`;
    if (force || previousIdentity !== nextIdentity) {
      this.#coverageAnalysis.update(snapshot, force);
      this.#exportAnalysis.reset();
    }
    const previousSnapshot = this.#snapshot;
    this.#snapshot = snapshot;
    this.#investigation = new InvestigationModel(snapshot);
    if (previousSnapshot && previousSnapshot !== snapshot) previousSnapshot.dispose?.();
  }

  async start(): Promise<number> {
    if (this.#port) return this.#port;
    for (let port = this.options.port; port < this.options.port + 100; port += 1) {
      try {
        await new Promise<void>((resolvePromise, reject) => {
          const onError = (error: NodeJS.ErrnoException) => {
            this.#server.off("listening", onListening);
            reject(error);
          };
          const onListening = () => {
            this.#server.off("error", onError);
            resolvePromise();
          };
          this.#server.once("error", onError);
          this.#server.once("listening", onListening);
          this.#server.listen(port, "127.0.0.1");
        });
        this.#port = port;
        return port;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      }
    }
    throw new Error(
      `No free port found between ${this.options.port} and ${this.options.port + 99}.`,
    );
  }

  async close(): Promise<void> {
    await Promise.all([this.#coverageAnalysis.close(), this.#exportAnalysis.close()]);
    this.#snapshot?.dispose?.();
    this.#snapshot = null;
    this.#investigation = null;
    const temporaryDataDirectory = this.#temporaryDataDirectory;
    this.#temporaryDataDirectory = null;
    if (temporaryDataDirectory) {
      await temporaryDataDirectory
        .then((directory) => rm(directory, { recursive: true, force: true }))
        .catch(() => undefined);
    }
    if (!this.#server.listening) return;
    await new Promise<void>((resolvePromise, reject) => {
      this.#server.close((error) => (error ? reject(error) : resolvePromise()));
      this.#server.closeIdleConnections();
    });
    this.#port = null;
  }

  async #snapshotDataDirectory(): Promise<string> {
    if (this.dataDirectory) return this.dataDirectory;
    this.#temporaryDataDirectory ??= mkdtemp(join(tmpdir(), "rspack-coverage-imports-"));
    return this.#temporaryDataDirectory;
  }

  #validHost(request: IncomingMessage): boolean {
    const hostname = request.headers.host?.split(":")[0]?.replace(/^\[|\]$/g, "");
    return hostname === "127.0.0.1" || hostname === "localhost";
  }

  #authorized(request: IncomingMessage, url: URL): boolean {
    return (
      request.headers["x-rspack-coverage-token"] === this.token ||
      url.searchParams.get("token") === this.token
    );
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.#validHost(request)) {
      sendJson(response, 403, { error: "Invalid host" });
      return;
    }
    const url = new URL(request.url ?? "/", this.origin ?? "http://127.0.0.1");
    const pathname = safeDecode(url.pathname);

    if (pathname.startsWith(`${ANALYSIS_PREFIX}api/`)) {
      if (!this.#authorized(request, url)) {
        sendJson(response, 401, { error: "Missing or invalid analysis token" });
        return;
      }
      try {
        await this.#serveApi(request, pathname, url, response);
      } catch (error) {
        this.#serveApiError(error, response);
      }
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }

    if (pathname.startsWith(ANALYSIS_PREFIX)) {
      this.#serveAnalysisUi(pathname, response);
      return;
    }

    this.#serveApplication(pathname, request, response);
  }

  async #serveApi(
    request: IncomingMessage,
    pathname: string,
    url: URL,
    response: ServerResponse,
  ): Promise<void> {
    const snapshot = this.#snapshot;
    if (pathname === `${ANALYSIS_PREFIX}api/snapshot` && request.method === "POST") {
      if (this.#snapshotImporting) {
        sendJson(response, 409, { error: "Another snapshot import is already in progress." });
        return;
      }
      const contentLength = request.headers["content-length"];
      if (
        typeof contentLength === "string" &&
        Number.isFinite(Number(contentLength)) &&
        Number(contentLength) > MAX_PORTABLE_SNAPSHOT_BYTES
      ) {
        request.resume();
        throw new PortableSnapshotTooLargeError(
          "Portable snapshot exceeds the 32 GiB streamed upload guard.",
        );
      }
      this.#snapshotImporting = true;
      try {
        const imported = await importPortableSnapshot(
          request,
          await this.#snapshotDataDirectory(),
          snapshot?.storage?.snapshotId,
        );
        this.update(imported.snapshot, true);
        sendJson(response, 200, {
          snapshotId: imported.snapshot.storage?.snapshotId,
          bytes: imported.bytes,
          build: imported.snapshot.manifest,
        });
      } finally {
        this.#snapshotImporting = false;
      }
      return;
    }
    if (!snapshot) {
      sendJson(response, 503, { error: "Build data is not ready" });
      return;
    }
    if (pathname === `${ANALYSIS_PREFIX}api/snapshot`) {
      if (request.method === "GET" || request.method === "HEAD") {
        const archive = await createPortableSnapshotArchive(snapshot);
        response.writeHead(200, {
          "Content-Type": "application/vnd.rspack.coverage-snapshot",
          "Content-Length": archive.bytes,
          "Content-Disposition": `attachment; filename="${archive.filename}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        if (request.method === "HEAD") response.end();
        else {
          archive.content.on("error", (error) => response.destroy(error));
          archive.content.pipe(response);
        }
        return;
      }
      response.writeHead(405, { Allow: "GET, HEAD, POST" });
      response.end();
      return;
    }
    if (pathname === `${ANALYSIS_PREFIX}api/coverage-analysis`) {
      const buildHash = url.searchParams.get("buildHash");
      if (!buildHash) {
        sendJson(response, 400, { error: "buildHash is required" });
        return;
      }
      if (request.method === "POST") {
        const status = await this.#coverageAnalysis.submit(
          buildHash,
          request,
          parseCoveragePrecision(url.searchParams.get("precision")),
        );
        sendJson(response, 202, status);
        return;
      }
      if (request.method === "GET" || request.method === "HEAD") {
        this.#serveCoverageAnalysis(this.#coverageAnalysis.view(buildHash), response);
        return;
      }
      response.writeHead(405, { Allow: "GET, HEAD, POST" });
      response.end();
      return;
    }
    if (pathname === `${ANALYSIS_PREFIX}api/coverage-analysis/reuse`) {
      if (request.method !== "POST") {
        response.writeHead(405, { Allow: "POST" });
        response.end();
        return;
      }
      const buildHash = url.searchParams.get("buildHash");
      if (!buildHash) {
        sendJson(response, 400, { error: "buildHash is required" });
        return;
      }
      const status = await this.#coverageAnalysis.reuse(
        buildHash,
        parseCoveragePrecision(url.searchParams.get("precision")),
      );
      sendJson(response, 202, status);
      return;
    }
    if (pathname === `${ANALYSIS_PREFIX}api/coverage-analysis/source`) {
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET" });
        response.end();
        return;
      }
      const buildHash = url.searchParams.get("buildHash");
      const fileId = url.searchParams.get("fileId");
      if (!buildHash || !fileId) {
        sendJson(response, 400, { error: "buildHash and fileId are required" });
        return;
      }
      const source = await this.#coverageAnalysis.source(
        buildHash,
        fileId,
        url.searchParams.get("moduleId"),
      );
      sendJson(response, 200, source);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    if (pathname === `${ANALYSIS_PREFIX}api/build`) {
      sendJson(response, 200, snapshot.manifest);
      return;
    }
    if (pathname === `${ANALYSIS_PREFIX}api/chunks`) {
      sendJson(response, 200, snapshot.manifest.chunks);
      return;
    }
    if (pathname === `${ANALYSIS_PREFIX}api/source-exports`) {
      const buildHash = url.searchParams.get("buildHash");
      const source = url.searchParams.get("source");
      if (!buildHash || !source) {
        sendJson(response, 400, { error: "buildHash and source are required" });
        return;
      }
      if (buildHash !== snapshot.manifest.hash) {
        sendJson(response, 409, {
          error: "The build changed. Refresh the report and import Coverage for the latest build.",
        });
        return;
      }
      const status = this.#exportAnalysis.request(snapshot, source);
      if (status.status === "pending") sendJson(response, 202, status);
      else if (status.status === "error") sendJson(response, 500, status);
      else sendJson(response, 200, status);
      return;
    }
    if (pathname === `${ANALYSIS_PREFIX}api/evidence-gaps`) {
      sendJson(response, 200, this.#investigation?.evidenceGaps() ?? []);
      return;
    }
    const moduleMatch = pathname.match(
      /\/api\/modules\/([^/]+)(?:\/(code|references|export-chain|context))?$/,
    );
    if (moduleMatch) {
      const moduleId = moduleMatch[1] ?? "";
      const action = moduleMatch[2] ?? "detail";
      if (action === "detail") {
        const detail = this.#investigation?.module(moduleId) ?? null;
        sendJson(response, detail ? 200 : 404, detail ?? { error: "Unknown module" });
        return;
      }
      if (action === "code") {
        const view = url.searchParams.get("view") === "output" ? "output" : "source";
        const code =
          this.#investigation?.code(
            moduleId,
            view,
            url.searchParams.get("source"),
            Number(url.searchParams.get("offset") ?? 0),
            Number(url.searchParams.get("limit") ?? 240_000),
          ) ?? null;
        sendJson(response, code ? 200 : 404, code ?? { error: "Unknown module" });
        return;
      }
      if (action === "references") {
        const requestedDirection = url.searchParams.get("direction");
        const direction =
          requestedDirection === "in" || requestedDirection === "out" ? requestedDirection : "both";
        const references =
          this.#investigation?.references(
            moduleId,
            direction,
            Number(url.searchParams.get("cursor") ?? 0),
            Number(url.searchParams.get("limit") ?? 80),
          ) ?? null;
        sendJson(response, references ? 200 : 404, references ?? { error: "Unknown module" });
        return;
      }
      if (action === "export-chain") {
        const exportedName = url.searchParams.get("export")?.trim() ?? "";
        if (!exportedName) {
          sendJson(response, 400, { error: "export is required" });
          return;
        }
        const chain = this.#investigation?.exportImporterChain(moduleId, exportedName) ?? null;
        sendJson(response, chain ? 200 : 404, chain ?? { error: "Unknown module or export" });
        return;
      }
      const context = this.#investigation?.aiContext(moduleId) ?? null;
      sendJson(response, context ? 200 : 404, context ?? { error: "Unknown module" });
      return;
    }
    const snippetMatch = pathname.match(/\/api\/references\/([^/]+)\/snippet$/);
    if (snippetMatch) {
      const snippet =
        this.#investigation?.snippet(
          snippetMatch[1] ?? "",
          Number(url.searchParams.get("context") ?? 3),
        ) ?? null;
      if (snippet?.available && snippet.code) {
        const fileId = snippet.code.sourceId ?? snippet.code.filename;
        const usageLine = snippet.location?.start.line;
        try {
          const detail = await this.#coverageAnalysis.source(
            snapshot.manifest.hash,
            fileId,
            snippet.edge.originId,
            usageLine,
          );
          snippet.code.sourceId = detail.id;
          snippet.code.filename = detail.id;
          snippet.code.spans = sourceLinesCoverageSpans(snippet.code.content, detail.lines);
          if (snippet.highlight && usageLine) {
            const line = detail.lines[usageLine - 1];
            if (line) snippet.highlight.coverageStatus = sourceLineCoverageStatus(line);
          }
        } catch (error) {
          if (
            !(error instanceof CoverageReportNotReadyError) &&
            !(error instanceof MissingCoverageSourceError)
          ) {
            throw error;
          }
        }
      }
      sendJson(response, snippet ? 200 : 404, snippet ?? { error: "Unknown reference" });
      return;
    }
    sendJson(response, 404, { error: "Unknown API route" });
  }

  #serveCoverageAnalysis(status: CoverageAnalysisView, response: ServerResponse): void {
    if (status.status !== "complete-file") {
      sendJson(response, status.status === "pending" ? 202 : 200, status);
      return;
    }
    if (!existsSync(status.reportFile)) {
      sendJson(response, 500, { error: "Coverage report file is unavailable" });
      return;
    }
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": statSync(status.reportFile).size,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(status.reportFile).pipe(response);
  }

  #serveApiError(error: unknown, response: ServerResponse): void {
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (
      error instanceof CoverageUploadTooLargeError ||
      error instanceof PortableSnapshotTooLargeError
    ) {
      sendJson(response, 413, { error: error.message });
    } else if (error instanceof PortableSnapshotFormatError) {
      sendJson(response, 400, { error: error.message });
    } else if (error instanceof CoverageBuildChangedError) {
      sendJson(response, 409, { error: error.message });
    } else if (error instanceof MissingCoverageRecordingError) {
      sendJson(response, 404, { error: error.message });
    } else if (error instanceof CoverageReportNotReadyError) {
      sendJson(response, 409, { error: error.message });
    } else if (error instanceof MissingCoverageSourceError) {
      sendJson(response, 404, { error: error.message });
    } else if (error instanceof SyntaxError || error instanceof TypeError) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    } else {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #serveAnalysisUi(pathname: string, response: ServerResponse): void {
    const relative = pathname.slice(ANALYSIS_PREFIX.length) || "index.html";
    const requested = relative.endsWith("/") ? `${relative}index.html` : relative;
    const absolute = resolve(this.#uiDirectory, normalize(requested));
    if (!absolute.startsWith(`${this.#uiDirectory}${sep}`) && absolute !== this.#uiDirectory) {
      response.writeHead(403);
      response.end();
      return;
    }
    const file =
      existsSync(absolute) && statSync(absolute).isFile()
        ? absolute
        : join(this.#uiDirectory, "index.html");
    if (!existsSync(file)) {
      response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Rspack Coverage UI is missing. Reinstall the package or run its build.");
      return;
    }
    const headers: Record<string, string> = {
      "Content-Type": contentType(file),
      "Cache-Control": file.endsWith("index.html")
        ? "no-store"
        : "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    };
    if (file.endsWith("index.html")) {
      const html = readFileSync(file, "utf8").replace(
        "</head>",
        `<meta name="rspack-coverage-token" content="${this.token}"></head>`,
      );
      response.writeHead(200, headers);
      response.end(html);
      return;
    }
    response.writeHead(200, headers);
    createReadStream(file).pipe(response);
  }

  #serveApplication(pathname: string, request: IncomingMessage, response: ServerResponse): void {
    const snapshot = this.#snapshot;
    if (!snapshot?.manifest.previewAvailable) {
      response.writeHead(503, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(
        "<!doctype html><title>Preview unavailable</title><h1>Application preview unavailable</h1><p>Open the Coverage report to inspect build diagnostics.</p>",
      );
      return;
    }
    const matchedAsset = snapshot.manifest.assets.find(
      (asset) => asset.urlPath === pathname || `/${asset.name.replace(/^\/+/, "")}` === pathname,
    );
    if (matchedAsset) {
      const content = snapshot.assets.get(matchedAsset.id);
      if (content) {
        response.writeHead(200, {
          "Content-Type": contentType(matchedAsset.name),
          "Content-Length": content.byteLength,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(content);
        return;
      }
    }

    const outputFile = resolve(snapshot.outputPath, `.${pathname}`);
    if (
      outputFile.startsWith(`${snapshot.outputPath}${sep}`) &&
      existsSync(outputFile) &&
      statSync(outputFile).isFile()
    ) {
      response.writeHead(200, {
        "Content-Type": contentType(outputFile),
        "Cache-Control": "no-store",
      });
      createReadStream(outputFile).pipe(response);
      return;
    }

    const acceptsHtml = request.headers.accept?.includes("text/html") ?? false;
    if (
      (pathname === "/" || (this.options.historyApiFallback && acceptsHtml)) &&
      snapshot.indexAsset
    ) {
      const content = snapshot.assets.get(`html:${snapshot.indexAsset}`);
      if (content) {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        response.end(content);
        return;
      }
    }
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}
